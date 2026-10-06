import { M, getSettings, defer } from './db.js';
import { sendMail, layout, appUrl, mailConfigured, esc } from './mailer.js';
import { taskLabel, taskScore } from './taskScore.js';
import { dateKey } from './dates.js';
import { dayFlags, hoursCfg, label12, minutesText } from './hours.js';

/*
 * Who gets which email (role-wise):
 *  EMPLOYEE  welcome + login details, check-in, check-out, left the office (auto check-out), absent alert,
 *            request submitted / approved / rejected, attendance corrected or voided, profile changed by someone else
 *  HR        welcome, approvals waiting for HR, request outcomes, absent digest of their people, plus the personal mails above
 *  MANAGER   welcome, approvals waiting for the Manager, request outcomes, absent digest of everyone under them
 *  COO       welcome, approvals waiting for the COO, and (like Admin) attendance + change notifications for everyone
 *  ADMIN     "Notification email" (or every Admin's email): attendance exceptions/summary, all changes and outcomes, security
 * Email is best-effort: failures are recorded in Settings and never affect attendance or approvals.
 */

function queue(label, fn) {
  const run = async () => {
    try {
      if (!mailConfigured()) return;
      await fn();
      await M.Setting.updateOne({ key: 'system' }, { $unset: { lastMailError: '', lastMailErrorAt: '' } });
    } catch (e) {
      console.error(`Email (${label}) failed:`, e.message);
      await M.Setting.updateOne({ key: 'system' }, { $set: { lastMailError: `${label}: ${String(e.message).slice(0, 300)}`, lastMailErrorAt: new Date() } }).catch(() => {});
    }
  };
  defer(run);
}

// ---------- in-app notifications (bell) ----------
/** Show a notification in the app to one person or several. `to` = user id(s); empty ids are ignored. */
export function note(to, { title, body, link }) {
  defer(async () => {
    try {
      const ids = [...new Set([].concat(to || []).filter(Boolean).map(String))];
      if (ids.length) await M.Notification.insertMany(ids.map((user) => ({ user, title, body, link })));
    } catch (e) { console.error('In-app notification failed:', e.message); }
  });
}
const idsOf = (q) => M.User.find({ status: 'ACTIVE', ...q }).distinct('_id');
/** Admin + COO accounts, minus whoever did the action. */
async function leaderIds(except = []) {
  const skip = new Set([].concat(except).filter(Boolean).map(String));
  return (await idsOf({ role: { $in: ['ADMIN', 'COO'] } })).filter((id) => !skip.has(String(id)));
}

// ---------- recipients ----------
const clean = (list) => [...new Set(list.flat().filter(Boolean).map((e) => String(e).trim().toLowerCase()))];
const activeEmails = (q) => M.User.find({ status: 'ACTIVE', email: { $ne: null }, ...q }).distinct('email');
/** Settings "Notification email" if set, otherwise every active Admin's email. */
export async function adminRecipients() {
  const s = await getSettings();
  if (s.notificationEmail) return [s.notificationEmail];
  if (process.env.REPORT_EMAIL) return [process.env.REPORT_EMAIL]; // the Admin login email is often a placeholder that bounces
  return activeEmails({ role: 'ADMIN' });
}
/** Admin + COO. `except` = the person who did the action (they don't need to be told about their own action). */
async function leadership(except = []) {
  const skip = new Set(clean([except]));
  return clean([await adminRecipients(), await activeEmails({ role: 'COO' })]).filter((e) => !skip.has(e));
}
const emailOf = async (id) => (id ? (await M.User.findOne({ _id: id, status: 'ACTIVE' }).select('email').lean())?.email : null);
const nameOf = (u) => (u?.name || 'there').split(/\s+/)[0];
const link = (path = '') => `${appUrl()}${path}`;

// ---------- formatting ----------
const IST = 'Asia/Kolkata';
const fmtTime = (d) => (d ? new Date(d).toLocaleTimeString('en-IN', { timeZone: IST, hour: '2-digit', minute: '2-digit', hour12: true }).toUpperCase() : '—');
const fmtDay = (d) => new Date(d).toLocaleDateString('en-IN', { timeZone: IST, weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
const dayLabel = (key) => new Date(`${key}T00:00:00Z`).toLocaleDateString('en-IN', { timeZone: 'UTC', weekday: 'long', day: 'numeric', month: 'long' });
const idOf = (u) => `${u.name}${u.employeeId ? ` (${u.employeeId})` : ''}`;
const hoursOf = (rec) => Math.round(((rec.sessions || []).reduce((ms, s) => ms + (s.checkIn && s.checkOut ? new Date(s.checkOut) - new Date(s.checkIn) : 0), 0) / 3600000) * 100) / 100;
const hm = (h) => `${Math.floor(h)} h ${Math.round((h % 1) * 60)} min`;
const LBL = { name: 'Name', email: 'Email', mobile: 'Mobile', fatherName: "Father's name", motherName: "Mother's name", dob: 'Date of birth', address: 'Address', city: 'City', state: 'State',
  pincode: 'PIN code', emergencyContact1: 'Emergency contact 1', emergencyContact2: 'Emergency contact 2', designation: 'Designation', joiningDate: 'Joining date',
  employeeType: 'Employee type', department: 'Department', manager: 'Reports to', hr: 'HR', location: 'Location', employeeId: 'Employee ID', status: 'Status', role: 'Role' };
const val = (v) => (v == null || v === '' ? 'Not Provided' : typeof v === 'object' ? [v.name, v.relationship, v.mobile].filter(Boolean).join(' · ') || 'Not Provided' : String(v));
const TYPE = { PROFILE_CHANGE: 'profile change', ATTENDANCE_CORRECTION: 'attendance correction' };
const STAGE = { PENDING_HR: 'HR', PENDING_MANAGER: 'Manager', PENDING_COO: 'COO', PENDING_ADMIN: 'Admin' };
const ROLE = { ADMIN: 'Admin', COO: 'COO', MANAGER: 'Manager', HR: 'HR', EMPLOYEE: 'Employee' };

// ---------- 1. New account / password reset (to that person) ----------
export function notifyWelcome({ userId, password, kind = 'created' }) {
  if (kind === 'created') {
    note(userId, { title: 'Welcome to Shine Infosolutions!', link: '/profile',
      body: 'We are glad to have you on the team. Complete your profile, add your photo, and check in from the office each day. Your daily tasks appear under Tasks.' });
  }
  queue('welcome', async () => {
    const u = await M.User.findById(userId).select('name email employeeId role mobile').lean();
    if (!u?.email) return;
    const reset = kind === 'reset';
    const m = layout({
      tone: reset ? 'warn' : 'ok', preheader: `Your login for Shine Attendance: ${u.employeeId || u.email}`,
      title: reset ? 'Your password was reset' : `Welcome to Shine Attendance, ${nameOf(u)}!`, greeting: `Hi ${nameOf(u)},`,
      intro: reset ? 'An Admin reset your password. Use the temporary password below to sign in; you will be asked to choose a new one.'
        : `Your ${ROLE[u.role]} account is ready. Use these details to sign in. You will be asked to choose your own password the first time.`,
      highlight: password ? `Password: ${password}` : undefined,
      rows: [['User ID (login)', u.employeeId || u.email], ['Also works as login', [u.email, u.mobile].filter(Boolean).join(' or ') || '—'], ['Role', ROLE[u.role]], ['Sign in at', appUrl()]],
      notes: ['Sign in with your User ID and the password above.', 'Change the password right after your first sign-in.', 'Attendance works only when you are at the office (check-in needs a live camera photo and location).', 'Keep these details private. Do not share your password with anyone.'],
      link: link('/login'), linkText: 'Sign in',
    });
    await sendMail({ to: u.email, subject: reset ? 'Shine Attendance: your password was reset' : 'Welcome to Shine Attendance: your login details', ...m });
  });
}

// ---------- 2. Attendance: check-in / check-out (to that employee; optionally to Admin + COO) ----------
async function everyCheckinRecipients(u) { const s = await getSettings(); return s.mailEveryCheckin ? leadership([u.email]) : []; }

export function notifyCheckin({ userId, recId, at, distance }) {
  queue('check-in', async () => {
    const [u, rec, cfg] = await Promise.all([M.User.findById(userId).select('name email employeeId').lean(), M.Attendance.findById(recId).lean(), getSettings()]);
    if (!u) return;
    const f = rec ? dayFlags(rec, cfg) : { late: false };
    const c = hoursCfg(cfg);
    const m = layout({
      tone: f.late ? 'warn' : 'ok', title: f.late ? 'Checked in (late)' : 'Checked in', greeting: `Hi ${nameOf(u)},`,
      intro: f.late ? `Your attendance for ${fmtDay(at)} has been recorded. You were ${minutesText(f.lateMinutes)} after the office start time.` : `Your attendance for ${fmtDay(at)} has been recorded.`,
      highlight: `In at ${fmtTime(at)}`,
      rows: [['Date', fmtDay(at)], ['Office hours', `${label12(c.workStart)} to ${label12(c.workEnd)}`], ...(distance != null ? [['Distance from office', `${distance} m`]] : [])], link: link('/attendance'), linkText: 'View my attendance',
    });
    await sendMail({ to: u.email, subject: f.late ? `Checked in late at ${fmtTime(at)}` : `Checked in at ${fmtTime(at)}`, ...m });
    const lead = await everyCheckinRecipients(u);
    if (lead.length) {
      const l = layout({ tone: 'info', title: `${u.name} checked in`, intro: `${idOf(u)} checked in at ${fmtTime(at)}.`, link: link('/attendance'), linkText: 'Open attendance' });
      await sendMail({ to: lead, subject: `${u.name} checked in (${fmtTime(at)})`, ...l });
    }
  });
}

export function notifyCheckout({ userId, recId, at, auto = false, endOfDay = false, distance }) {
  if (auto) note(userId, { title: 'You were checked out automatically', body: `You moved ${distance ?? 'away'} m from the office at ${fmtTime(at)}. To check in again you will need to give a reason.`, link: '/' });
  else if (endOfDay) note(userId, { title: 'Checked out at office closing', body: `Office hours are over, so you were checked out at ${fmtTime(at)}.`, link: '/attendance' });
  queue('check-out', async () => {
    const [u, rec, cfg] = await Promise.all([M.User.findById(userId).select('name email employeeId').lean(), M.Attendance.findById(recId).lean(), getSettings()]);
    if (!u || !rec) return;
    const hrs = hoursOf(rec);
    const f = dayFlags(rec, cfg);
    const c = hoursCfg(cfg);
    const m = endOfDay
      ? layout({
        tone: 'info', title: 'Checked out at office closing', greeting: `Hi ${nameOf(u)},`, intro: `Office hours ended at ${label12(c.workEnd)}, so you were checked out automatically.`,
        highlight: `Out at ${fmtTime(at)}`, rows: [['Date', fmtDay(at)], ['Total hours today', hm(hrs)]], link: link('/attendance'), linkText: 'View my attendance',
      })
      : auto
      ? layout({
        tone: 'warn', title: 'You were checked out automatically', greeting: `Hi ${nameOf(u)},`, intro: `You moved ${distance ?? 'more than 20'} m away from the office, so your attendance was closed at ${fmtTime(at)}.`,
        highlight: `Out at ${fmtTime(at)}`, rows: [['Date', fmtDay(at)], ['Hours so far today', hm(hrs)]],
        notes: ['If you come back, you can check in again, but you will need to enter a reason for leaving.'], link: link('/'), linkText: 'Open app',
      })
      : layout({
        tone: 'info', title: 'Checked out', greeting: `Hi ${nameOf(u)},`, intro: `Thanks for today. Your check-out was recorded at ${fmtTime(at)}.`, highlight: `Out at ${fmtTime(at)}`,
        rows: [['Date', fmtDay(at)], ['Total hours today', hm(hrs)], ['Office ends', label12(c.workEnd)]],
        notes: f.early ? [`You left ${minutesText(f.earlyMinutes)} before the office end time (${label12(c.workEnd)}).`] : [], link: link('/attendance'), linkText: 'View my attendance',
      });
    await sendMail({ to: u.email, subject: endOfDay ? `Checked out at office closing (${fmtTime(at)})` : auto ? 'You were checked out automatically (left the office)' : `Checked out at ${fmtTime(at)}`, ...m });
    const lead = await everyCheckinRecipients(u);
    if (lead.length) {
      const l = layout({ tone: auto ? 'warn' : 'info', title: `${u.name} ${auto ? 'left the office' : 'checked out'}`, intro: `${idOf(u)} ${auto ? 'was checked out automatically' : 'checked out'} at ${fmtTime(at)}. Hours today: ${hm(hrs)}.`, link: link('/attendance'), linkText: 'Open attendance' });
      await sendMail({ to: lead, subject: `${u.name} ${auto ? 'left the office' : 'checked out'} (${fmtTime(at)})`, ...l });
    }
  });
}

/** Someone came back after leaving the premises and gave a reason (to Admin + COO). */
export function notifyReentry({ userId, reason, at }) {
  defer(async () => {
    const u = await M.User.findById(userId).select('name').lean();
    if (u) note(await leaderIds(userId), { title: `${u.name} came back to the office`, body: `Checked in again at ${fmtTime(at)}. Reason: ${reason}`, link: `/users/${userId}` });
  });
  queue('re-entry', async () => {
    const u = await M.User.findById(userId).select('name employeeId').lean();
    if (!u) return;
    const m = layout({
      tone: 'warn', title: `${u.name} checked in again after leaving the office`, intro: 'They had been checked out automatically after moving away from the premises.',
      rows: [['Employee', idOf(u)], ['Back at', fmtTime(at)], ['Reason given', reason]], link: link(`/users/${u._id}`), linkText: 'Open profile',
    });
    await sendMail({ to: await leadership(), subject: `${u.name} re-entered after leaving the office`, ...m });
  });
}

/** Attendance corrected or voided: tell the employee and Admin + COO (not the person who did it). */
export function notifyAttendanceChange({ kind, recId, actor, reason, oldData, newData }) {
  defer(async () => {
    const rec = await M.Attendance.findById(recId).select('user date').lean();
    if (rec && String(rec.user) !== String(actor?._id)) {
      note(rec.user, { title: `Your attendance for ${dayLabel(rec.date)} was ${kind === 'voided' ? 'voided' : 'corrected'}`, body: `By ${actor?.name || 'an administrator'}. Reason: ${reason}`, link: '/attendance' });
    }
  });
  queue(`attendance ${kind}`, async () => {
    const rec = await M.Attendance.findById(recId).populate('user', 'name email employeeId').lean();
    if (!rec?.user) return;
    const show = (o) => (o == null ? '—' : typeof o === 'object' ? Object.entries(o).map(([k, v]) => `${k}: ${v && typeof v !== 'object' ? v : JSON.stringify(v)}`).join(', ') : String(o));
    const by = actor ? `${actor.name || ROLE[actor.role]} (${ROLE[actor.role] || actor.role})` : 'An administrator';
    const rows = [['Employee', idOf(rec.user)], ['Date', dayLabel(rec.date)], ['Before', show(oldData)], ['After', show(newData)], ['Changed by', by], ['Reason', reason]];
    const word = kind === 'voided' ? 'voided' : 'corrected';
    // Employees only get check-in / check-out mail; they see corrections in the app.
    await sendMail({
      to: await leadership([actor?.email]), subject: `Attendance ${word}: ${rec.user.name} (${rec.date})`,
      ...layout({ tone: 'warn', title: `Attendance ${word}`, intro: `${by} ${word} the attendance of ${rec.user.name} on ${dayLabel(rec.date)}.`, rows, link: link('/attendance'), linkText: 'Open attendance' }),
    });
  });
}

// ---------- 3. Requests and changes ----------
const changeRows = (changes) => Object.entries(changes || {}).map(([k, v]) => [LBL[k] || k, val(v)]);

/** A request is now waiting on someone: tell that approver. */
export function notifyPending(reqId) {
  defer(async () => {
    const r = await M.ChangeRequest.findById(reqId).populate('requester', 'name').populate('subject', 'name hr manager').lean();
    if (!r || !STAGE[r.status]) return;
    const to = r.status === 'PENDING_HR' ? [r.subject.hr] : r.status === 'PENDING_MANAGER' ? [r.subject.manager]
      : await idsOf({ role: r.status === 'PENDING_COO' ? 'COO' : 'ADMIN' });
    note(to, { title: `Approval needed: ${TYPE[r.type]}`, body: `${r.requester.name} submitted a ${TYPE[r.type]} for ${r.subject.name}.`, link: '/requests' });
  });
  queue('approval request', async () => {
    const r = await M.ChangeRequest.findById(reqId).populate('requester', 'name role').populate('subject', 'name employeeId hr manager').lean();
    if (!r || !STAGE[r.status]) return;
    let to = [];
    if (r.status === 'PENDING_HR') to = [await emailOf(r.subject.hr)];
    else if (r.status === 'PENDING_MANAGER') to = [await emailOf(r.subject.manager)];
    else if (r.status === 'PENDING_COO') to = await activeEmails({ role: 'COO' });
    else to = await adminRecipients();
    const rows = [['Employee', idOf(r.subject)], ['Raised by', `${r.requester.name} (${ROLE[r.requester.role]})`], ...(r.type === 'PROFILE_CHANGE' ? changeRows(r.changes) : []), ['Reason', r.reason]];
    await sendMail({
      to: clean([to]), subject: `Approval needed: ${TYPE[r.type]} for ${r.subject.name}`,
      ...layout({ tone: 'warn', title: `Approval needed: ${TYPE[r.type]}`, intro: `${r.requester.name} submitted a ${TYPE[r.type]} for ${r.subject.name}. It is waiting for ${STAGE[r.status]}.`, rows, link: link('/requests'), linkText: 'Review request' }),
    });
  });
}

/** Approved or rejected: Admin + COO (the requester and employee see the outcome in the app). */
export function notifyDecision(reqId) {
  defer(async () => {
    const r = await M.ChangeRequest.findById(reqId).select('type status requester subject history').lean();
    if (!r || !['APPROVED', 'REJECTED'].includes(r.status)) return;
    const last = r.history.at(-1);
    const word = r.status === 'APPROVED' ? 'approved' : 'rejected';
    note([r.requester, r.subject], { title: `Your ${TYPE[r.type]} request was ${word}`,
      body: `${word[0].toUpperCase()}${word.slice(1)} by ${ROLE[last?.byRole] || 'a reviewer'}${last?.note ? `: ${last.note}` : '.'}`, link: r.type === 'PROFILE_CHANGE' ? '/profile' : '/attendance' });
  });
  queue('request decision', async () => {
    const r = await M.ChangeRequest.findById(reqId).populate('requester', 'name email role').populate('subject', 'name email employeeId').lean();
    if (!r || !['APPROVED', 'REJECTED'].includes(r.status)) return;
    const last = r.history.at(-1);
    const ok = r.status === 'APPROVED';
    const word = ok ? 'approved' : 'rejected';
    const by = last?.byRole ? ROLE[last.byRole] || last.byRole : 'a reviewer';
    const rows = [['Type', TYPE[r.type]], ['For', idOf(r.subject)], ...(r.type === 'PROFILE_CHANGE' ? changeRows(r.changes) : []), ['Reason', r.reason], ['Decision', `${word} by ${by}${last?.override ? ' (Admin override)' : ''}`], ...(last?.note ? [['Note', last.note]] : [])];
    await sendMail({
      to: await leadership([r.requester.email, r.subject.email]), subject: `${ok ? 'Approved' : 'Rejected'}: ${TYPE[r.type]} for ${r.subject.name}`,
      ...layout({ tone: ok ? 'ok' : 'bad', title: `Request ${word}`, intro: `${TYPE[r.type][0].toUpperCase()}${TYPE[r.type].slice(1)} for ${r.subject.name}, raised by ${r.requester.name}, was ${word} by ${by}.`, rows, link: link('/requests'), linkText: 'Open requests' }),
    });
  });
}

/** Details changed directly (Admin/COO/Manager edit): tell Admin + COO. `fields` = [[field, old, new]] */
export function notifyProfileChanged({ userId, actor, fields, reason }) {
  if (fields?.length && String(userId) !== String(actor?._id) && !fields.every(([k]) => k === 'status')) {
    note(userId, { title: 'Your details were updated', body: `${actor?.name || 'An administrator'} changed: ${fields.map(([k]) => LBL[k] || k).join(', ')}.`, link: '/profile' });
  }
  queue('profile changed', async () => {
    const u = await M.User.findById(userId).select('name email employeeId role').lean();
    if (!u || !fields?.length) return;
    const by = actor ? `${actor.name || ROLE[actor.role]} (${ROLE[actor.role] || actor.role})` : 'An administrator';
    const rows = [['Employee', idOf(u)], ...fields.map(([f, o, n]) => [LBL[f] || f, `${val(o)}  →  ${val(n)}`]), ['Changed by', by], ['Reason', reason]];
    await sendMail({
      to: await leadership([actor?.email, u.email]), subject: `Profile updated: ${u.name}`,
      ...layout({ tone: 'info', title: `Profile updated: ${u.name}`, intro: `${by} changed ${idOf(u)}.`, rows, link: link(`/users/${u._id}`), linkText: 'Open profile' }),
    });
  });
}

/** A task was assigned: tell the assignee in the app and by email. */
export function notifyTaskAssigned(taskId) {
  defer(async () => {
    const t = await M.Task.findById(taskId).populate('assignedBy', 'name role').lean();
    if (t) note(t.user, { title: 'New task assigned', body: `${t.title} (for ${dayLabel(t.date)}), from ${t.assignedBy?.name || 'your HR'}.`, link: '/tasks' });
  });
  queue('task assigned', async () => {
    const t = await M.Task.findById(taskId).populate('user', 'name email').populate('assignedBy', 'name role').lean();
    if (!t?.user?.email) return;
    const by = t.assignedBy ? `${t.assignedBy.name} (${ROLE[t.assignedBy.role] || t.assignedBy.role})` : 'HR';
    await sendMail({
      to: t.user.email, subject: `New task for ${dayLabel(t.date)}: ${t.title.slice(0, 60)}`,
      ...layout({ tone: 'info', title: 'New task assigned', greeting: `Hi ${nameOf(t.user)},`, intro: `${by} assigned you a task for ${dayLabel(t.date)}.`,
        highlight: t.title, rows: [...(t.details ? [['Details', t.details]] : []), ['Due', dayLabel(t.date)], ['Assigned by', by]],
        notes: ['Your work status is updated in the evening. A task that is not done shows as a late submission and scores 0 for the day.'], link: link('/tasks'), linkText: 'Open my tasks' }),
    });
  });
}

/** A message written by Admin / COO / Manager / HR, shown in the bell of the people they picked. */
export function notifyCustom({ to, title, body, sender }) {
  note(to, { title, body: `${body}\n— ${sender.name} (${ROLE[sender.role] || sender.role})`, link: '/' });
}

// ---------- 4. Security ----------
export function notifyLockout({ userId, ip }) {
  defer(async () => {
    const u = await M.User.findById(userId).select('name').lean();
    if (u) note(await idsOf({ role: 'ADMIN' }), { title: `Account locked: ${u.name}`, body: '5 wrong password attempts. Locked for 15 minutes.', link: `/users/${userId}` });
  });
  queue('account lock', async () => {
    const u = await M.User.findById(userId).select('name email employeeId role').lean();
    if (!u) return;
    await sendMail({
      to: await adminRecipients(), subject: `Account locked: ${u.name}`,
      ...layout({ tone: 'bad', title: `Account locked: ${u.name}`, intro: 'There were 5 wrong password attempts, so the account is locked for 15 minutes.', rows: [['Account', `${idOf(u)} · ${ROLE[u.role]}`], ['From IP', ip || 'unknown']], link: link('/admin/audit-logs'), linkText: 'Open audit logs' }),
    });
  });
}

// ---------- 5. Scheduled: evening report (only to the report address) ----------
const TD = 'padding:8px 10px;border-top:1px solid #e6e9f1;vertical-align:top;font-size:13px';
const TH = 'padding:8px 10px;text-align:left;font-size:11px;text-transform:uppercase;letter-spacing:.04em;color:#6b7489;background:#fafbfe';
const sessionText = (s) => `${fmtTime(s.checkIn)} – ${s.checkOut ? fmtTime(s.checkOut) : 'still in'}${s.autoCheckout ? ' (left office)' : s.endOfDay ? ' (office closed)' : ''}${s.corrected ? ' (corrected)' : ''}`;

/** Detailed day report: who came, when they came and left, hours, flags and task status. */
export async function sendDailyReport(date = dateKey()) {
  const cfg = await getSettings();
  const people = await M.User.find({ status: 'ACTIVE', role: { $ne: 'ADMIN' } }).select('name employeeId role designation').populate('department', 'name').sort({ name: 1 }).lean();
  const ids = people.map((p) => p._id);
  const [recs, tasks] = await Promise.all([
    M.Attendance.find({ date, status: 'ACTIVE', user: { $in: ids } }).lean(),
    M.Task.find({ date, user: { $in: ids } }).sort({ createdAt: 1 }).lean(),
  ]);
  const recOf = Object.fromEntries(recs.map((r) => [String(r.user), r]));
  const tasksOf = {};
  for (const t of tasks) (tasksOf[String(t.user)] ||= []).push(t);

  let late = 0, early = 0, left = 0, closed = 0, totalHrs = 0;
  const lines = people.map((p) => {
    const r = recOf[String(p._id)];
    const ts = tasksOf[String(p._id)] || [];
    const taskLine = ts.length ? `${ts.reduce((a, t) => a + taskScore(t), 0)}/${ts.length} done` : '—';
    const taskList = ts.map((t) => `${t.title}: ${taskLabel(t)}${t.note ? ` (${t.note})` : ''}`);
    if (!r) return { p, present: false, taskLine, taskList };
    const f = dayFlags(r, cfg);
    const hrs = hoursOf(r);
    totalHrs += hrs;
    if (f.late) late++;
    if (f.early) early++;
    if (r.sessions.some((s) => s.autoCheckout)) left++;
    if (r.sessions.some((s) => s.endOfDay)) closed++;
    const notes = [
      f.late && `Late ${minutesText(f.lateMinutes)}`, f.early && `Left ${minutesText(f.earlyMinutes)} early`,
      r.sessions.some((s) => s.inGeo?.verified === false) && 'Check-in outside office',
      ...r.sessions.filter((s) => s.lateReason).map((s) => `Late reason: ${s.lateReason}`),
      ...r.sessions.filter((s) => s.reentryReason).map((s) => `Came back ${fmtTime(s.checkIn)}: ${s.reentryReason}`),
      ...r.sessions.flatMap((s) => (s.breaks || []).map((b) => `Away ${fmtTime(b.outAt)} to ${fmtTime(b.backAt)}: ${b.reason}`)),
    ].filter(Boolean);
    return { p, present: true, first: r.sessions[0]?.checkIn, last: r.sessions.filter((s) => s.checkOut).at(-1)?.checkOut, hrs, sessions: r.sessions.map(sessionText), notes, taskLine, taskList };
  });
  const present = lines.filter((l) => l.present);
  const absent = lines.filter((l) => !l.present);
  const doneTasks = tasks.reduce((a, t) => a + taskScore(t), 0);
  const lateTasks = tasks.filter((t) => t.late).length;

  const cell = (v) => `<td style="${TD}">${v}</td>`;
  const list = (arr) => arr.map(esc).join('<br>');
  const row = (l, i) => `<tr>${cell(i + 1)}${cell(`<b>${esc(l.p.name)}</b><br><span style="color:#6b7489">${esc([l.p.employeeId, l.p.designation || ROLE[l.p.role], l.p.department?.name].filter(Boolean).join(' · '))}</span>`)}`
    + (l.present
      ? `${cell('<span style="color:#0d6a49;font-weight:600">Present</span>')}${cell(esc(fmtTime(l.first)))}${cell(esc(l.last ? fmtTime(l.last) : 'still in'))}${cell(esc(hm(l.hrs)))}${cell(list(l.sessions))}${cell(list(l.notes) || '—')}`
      : `${cell('<span style="color:#9c2a22;font-weight:600">Absent</span>')}${cell('—')}${cell('—')}${cell('—')}${cell('—')}${cell('—')}`)
    + `${cell(`<b>${esc(l.taskLine)}</b>${l.taskList.length ? `<br>${list(l.taskList)}` : ''}`)}</tr>`;
  const table = `<div style="overflow-x:auto;margin:18px 0"><table role="presentation" cellpadding="0" cellspacing="0" style="border:1px solid #e6e9f1;border-radius:12px;border-collapse:separate;width:100%;min-width:720px">
<tr>${['#', 'Employee', 'Status', 'In', 'Out', 'Hours', 'Sessions', 'Notes', 'Tasks'].map((h) => `<th style="${TH}">${h}</th>`).join('')}</tr>
${[...present, ...absent].map(row).join('\n')}</table></div>`;
  const text = [...present, ...absent].map((l) => l.present
    ? `${l.p.name}: in ${fmtTime(l.first)}, out ${l.last ? fmtTime(l.last) : 'still in'}, ${hm(l.hrs)}. ${[...l.sessions, ...l.notes].join('; ')}. Tasks ${l.taskLine}`
    : `${l.p.name}: ABSENT. Tasks ${l.taskLine}`).join('\n');

  const m = layout({
    tone: 'info', wide: true, title: `Daily attendance report: ${dayLabel(date)}`,
    intro: `${present.length} of ${people.length} people were present. Office hours ${label12(hoursCfg(cfg).workStart)} to ${label12(hoursCfg(cfg).workEnd)}.`,
    rows: [['Present', present.length], ['Absent', absent.length ? absent.map((l) => l.p.name).join(', ') : 'None'], ['Came late', late], ['Left early', early],
      ['Left the office (auto check-out)', left], ['Checked out at office closing', closed], ['Total hours worked', hm(totalHrs)],
      ['Tasks done on time', `${doneTasks} of ${tasks.length}`], ['Late submissions (score 0)', lateTasks]],
    extraHtml: table, extraText: text, link: link('/attendance'), linkText: 'Open attendance',
  });
  const to = process.env.REPORT_EMAIL ? [process.env.REPORT_EMAIL] : await adminRecipients();
  const r = await sendMail({ to, subject: `Attendance report ${date}: ${present.length}/${people.length} present`, ...m });
  return { date, present: present.length, total: people.length, tasks: tasks.length, ...r };
}
