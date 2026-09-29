import { after } from 'next/server';
import { M, getSettings } from './db.js';
import { sendMail, layout, appUrl, mailConfigured } from './mailer.js';
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
  try { after(run); } catch { run(); }
}

// ---------- recipients ----------
const clean = (list) => [...new Set(list.flat().filter(Boolean).map((e) => String(e).trim().toLowerCase()))];
const activeEmails = (q) => M.User.find({ status: 'ACTIVE', email: { $ne: null }, ...q }).distinct('email');
/** Settings "Notification email" if set, otherwise every active Admin's email. */
export async function adminRecipients() {
  const s = await getSettings();
  if (s.notificationEmail) return [s.notificationEmail];
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

export function notifyCheckout({ userId, recId, at, auto = false, distance }) {
  queue('check-out', async () => {
    const [u, rec, cfg] = await Promise.all([M.User.findById(userId).select('name email employeeId').lean(), M.Attendance.findById(recId).lean(), getSettings()]);
    if (!u || !rec) return;
    const hrs = hoursOf(rec);
    const f = dayFlags(rec, cfg);
    const c = hoursCfg(cfg);
    const m = auto
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
    await sendMail({ to: u.email, subject: auto ? 'You were checked out automatically (left the office)' : `Checked out at ${fmtTime(at)}`, ...m });
    const lead = await everyCheckinRecipients(u);
    if (lead.length) {
      const l = layout({ tone: auto ? 'warn' : 'info', title: `${u.name} ${auto ? 'left the office' : 'checked out'}`, intro: `${idOf(u)} ${auto ? 'was checked out automatically' : 'checked out'} at ${fmtTime(at)}. Hours today: ${hm(hrs)}.`, link: link('/attendance'), linkText: 'Open attendance' });
      await sendMail({ to: lead, subject: `${u.name} ${auto ? 'left the office' : 'checked out'} (${fmtTime(at)})`, ...l });
    }
  });
}

/** Someone came back after leaving the premises and gave a reason (to Admin + COO). */
export function notifyReentry({ userId, reason, at }) {
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
  queue(`attendance ${kind}`, async () => {
    const rec = await M.Attendance.findById(recId).populate('user', 'name email employeeId').lean();
    if (!rec?.user) return;
    const show = (o) => (o == null ? '—' : typeof o === 'object' ? Object.entries(o).map(([k, v]) => `${k}: ${v && typeof v !== 'object' ? v : JSON.stringify(v)}`).join(', ') : String(o));
    const by = actor ? `${actor.name || ROLE[actor.role]} (${ROLE[actor.role] || actor.role})` : 'An administrator';
    const rows = [['Employee', idOf(rec.user)], ['Date', dayLabel(rec.date)], ['Before', show(oldData)], ['After', show(newData)], ['Changed by', by], ['Reason', reason]];
    const word = kind === 'voided' ? 'voided' : 'corrected';
    await sendMail({
      to: rec.user.email, subject: `Your attendance for ${rec.date} was ${word}`,
      ...layout({ tone: 'warn', title: `Your attendance was ${word}`, greeting: `Hi ${nameOf(rec.user)},`, intro: `${by} ${word === 'voided' ? 'voided' : 'corrected'} your attendance for ${dayLabel(rec.date)}.`, rows, link: link('/attendance'), linkText: 'View my attendance' }),
    });
    await sendMail({
      to: await leadership([actor?.email]), subject: `Attendance ${word}: ${rec.user.name} (${rec.date})`,
      ...layout({ tone: 'warn', title: `Attendance ${word}`, intro: `${by} ${word} the attendance of ${rec.user.name} on ${dayLabel(rec.date)}.`, rows, link: link('/attendance'), linkText: 'Open attendance' }),
    });
  });
}

// ---------- 3. Requests and changes ----------
const changeRows = (changes) => Object.entries(changes || {}).map(([k, v]) => [LBL[k] || k, val(v)]);

/** A request was just submitted: confirm to the person it is about (and who raised it). */
export function notifySubmitted(reqId) {
  queue('request submitted', async () => {
    const r = await M.ChangeRequest.findById(reqId).populate('requester', 'name email role').populate('subject', 'name email employeeId').lean();
    if (!r) return;
    const waiting = STAGE[r.status] || 'approval';
    const same = String(r.requester._id) === String(r.subject._id);
    const rows = [['Type', TYPE[r.type]], ['For', idOf(r.subject)], ...(r.type === 'PROFILE_CHANGE' ? changeRows(r.changes) : []), ['Reason', r.reason], ['Waiting for', waiting]];
    await sendMail({
      to: r.requester.email, subject: `Your ${TYPE[r.type]} request was submitted`,
      ...layout({ tone: 'info', title: 'Request submitted', greeting: `Hi ${nameOf(r.requester)},`, intro: `Your ${TYPE[r.type]} request${same ? '' : ` for ${r.subject.name}`} is now waiting for ${waiting}. You will get an email when it is decided.`, rows, link: link('/requests'), linkText: 'View request' }),
    });
    if (!same && r.subject.email) {
      await sendMail({
        to: r.subject.email, subject: `A ${TYPE[r.type]} was requested for you`,
        ...layout({ tone: 'info', title: `A ${TYPE[r.type]} was requested for you`, greeting: `Hi ${nameOf(r.subject)},`, intro: `${r.requester.name} (${ROLE[r.requester.role]}) requested this. It is waiting for ${waiting}.`, rows, link: link('/requests'), linkText: 'View request' }),
      });
    }
  });
}

/** A request is now waiting on someone: tell that approver. */
export function notifyPending(reqId) {
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

/** Approved or rejected: the requester, the employee it is about, and Admin + COO. */
export function notifyDecision(reqId) {
  queue('request decision', async () => {
    const r = await M.ChangeRequest.findById(reqId).populate('requester', 'name email role').populate('subject', 'name email employeeId').lean();
    if (!r || !['APPROVED', 'REJECTED'].includes(r.status)) return;
    const last = r.history.at(-1);
    const ok = r.status === 'APPROVED';
    const word = ok ? 'approved' : 'rejected';
    const by = last?.byRole ? ROLE[last.byRole] || last.byRole : 'a reviewer';
    const rows = [['Type', TYPE[r.type]], ['For', idOf(r.subject)], ...(r.type === 'PROFILE_CHANGE' ? changeRows(r.changes) : []), ['Reason', r.reason], ['Decision', `${word} by ${by}${last?.override ? ' (Admin override)' : ''}`], ...(last?.note ? [['Note', last.note]] : [])];
    const same = String(r.requester._id) === String(r.subject._id);
    const person = (u, intro) => ({
      to: u.email, subject: `${ok ? 'Approved' : 'Rejected'}: ${TYPE[r.type]}`,
      ...layout({ tone: ok ? 'ok' : 'bad', title: `Request ${word}`, greeting: `Hi ${nameOf(u)},`, intro, rows, link: link(r.type === 'PROFILE_CHANGE' ? '/profile' : '/attendance'), linkText: 'Open app' }),
    });
    const detail = ok && r.type === 'PROFILE_CHANGE' ? ' The details are now updated.' : '';
    await sendMail(person(r.requester, same ? `Your ${TYPE[r.type]} has been ${word}.${detail}` : `The ${TYPE[r.type]} you requested for ${r.subject.name} has been ${word}.${detail}`));
    if (!same) await sendMail(person(r.subject, `The ${TYPE[r.type]} requested for you has been ${word}.${detail}`));
    await sendMail({
      to: await leadership([r.requester.email, r.subject.email]), subject: `${ok ? 'Approved' : 'Rejected'}: ${TYPE[r.type]} for ${r.subject.name}`,
      ...layout({ tone: ok ? 'ok' : 'bad', title: `Request ${word}`, intro: `${TYPE[r.type][0].toUpperCase()}${TYPE[r.type].slice(1)} for ${r.subject.name}, raised by ${r.requester.name}, was ${word} by ${by}.`, rows, link: link('/requests'), linkText: 'Open requests' }),
    });
  });
}

/** Details changed directly (Admin/COO/Manager edit): tell the employee and Admin + COO. `fields` = [[field, old, new]] */
export function notifyProfileChanged({ userId, actor, fields, reason }) {
  queue('profile changed', async () => {
    const u = await M.User.findById(userId).select('name email employeeId role').lean();
    if (!u || !fields?.length) return;
    const by = actor ? `${actor.name || ROLE[actor.role]} (${ROLE[actor.role] || actor.role})` : 'An administrator';
    const rows = [['Employee', idOf(u)], ...fields.map(([f, o, n]) => [LBL[f] || f, `${val(o)}  →  ${val(n)}`]), ['Changed by', by], ['Reason', reason]];
    const onlyStatus = fields.every(([f]) => f === 'status');
    if (!onlyStatus) {
      await sendMail({
        to: u.email, subject: 'Your details were updated',
        ...layout({ tone: 'info', title: 'Your details were updated', greeting: `Hi ${nameOf(u)},`, intro: `${by} updated your profile. If something looks wrong, contact HR.`, rows, link: link('/profile'), linkText: 'View my profile' }),
      });
    }
    await sendMail({
      to: await leadership([actor?.email, u.email]), subject: `Profile updated: ${u.name}`,
      ...layout({ tone: 'info', title: `Profile updated: ${u.name}`, intro: `${by} changed ${idOf(u)}.`, rows, link: link(`/users/${u._id}`), linkText: 'Open profile' }),
    });
  });
}

// ---------- 4. Security ----------
export function notifyLockout({ userId, ip }) {
  queue('account lock', async () => {
    const u = await M.User.findById(userId).select('name email employeeId role').lean();
    if (!u) return;
    await sendMail({
      to: await adminRecipients(), subject: `Account locked: ${u.name}`,
      ...layout({ tone: 'bad', title: `Account locked: ${u.name}`, intro: 'There were 5 wrong password attempts, so the account is locked for 15 minutes.', rows: [['Account', `${idOf(u)} · ${ROLE[u.role]}`], ['From IP', ip || 'unknown']], link: link('/admin/audit-logs'), linkText: 'Open audit logs' }),
    });
    if (u.email) {
      await sendMail({
        to: u.email, subject: 'Your Shine Attendance account was locked',
        ...layout({ tone: 'bad', title: 'Your account is locked for 15 minutes', greeting: `Hi ${nameOf(u)},`, intro: 'Someone entered a wrong password 5 times. If that was not you, tell your Admin.', notes: ['You can try again in 15 minutes, or ask an Admin to reset your password.'] }),
      });
    }
  });
}

// ---------- 5. Scheduled: morning absent check, evening summary ----------
const isSunday = (key) => new Date(`${key}T00:00:00Z`).getUTCDay() === 0;

/** Late-morning job: email each person who has not checked in, and a digest of absentees to those who oversee them. */
export async function sendAbsentAlerts() {
  const today = dateKey();
  if (isSunday(today)) return { date: today, skipped: 'Sunday (weekly off)' };
  const s = await getSettings();
  if (s.lastAbsentMailDate === today) return { date: today, skipped: 'already sent today' };
  await M.Setting.updateOne({ key: 'system' }, { $set: { lastAbsentMailDate: today } });

  const people = await M.User.find({ status: 'ACTIVE', role: { $ne: 'ADMIN' } }).select('name email employeeId role department hr').lean();
  const present = new Set((await M.Attendance.find({ date: today, status: 'ACTIVE', user: { $in: people.map((p) => p._id) } }).select('user').lean()).map((r) => String(r.user)));
  const absent = people.filter((p) => !present.has(String(p._id)));
  let personal = 0;
  for (const p of absent) {
    if (!p.email) continue;
    await sendMail({
      to: p.email, subject: `You have not checked in today (${today})`,
      ...layout({ tone: 'warn', title: 'You have not checked in yet', greeting: `Hi ${nameOf(p)},`, intro: `We have no attendance for you on ${dayLabel(today)}; office starts at ${label12(hoursCfg(s).workStart)}. If you are at the office, please check in. If you are on leave or working elsewhere, tell your manager or HR.`, link: link('/'), linkText: 'Check in now' }),
    });
    personal++;
  }

  const list = (arr) => (arr.length ? arr.slice(0, 40).map((p) => idOf(p)).join(', ') + (arr.length > 40 ? ` and ${arr.length - 40} more` : '') : 'None');
  const digest = async (to, arr, who) => {
    if (!to.length) return;
    await sendMail({
      to, subject: `Absent so far today: ${arr.length}`,
      ...layout({ tone: arr.length ? 'warn' : 'ok', title: `${arr.length} not checked in yet (${today})`, intro: `${who}. ${arr.length ? 'These people have no attendance yet today.' : 'Everyone has checked in.'}`, rows: [['Not checked in', list(arr)]], link: link('/attendance'), linkText: 'Open attendance' }),
    });
  };
  await digest(await leadership(), absent, 'Everyone in the company');
  // Managers oversee all HR and Employees; each HR oversees their own people and department.
  const managers = await M.User.find({ status: 'ACTIVE', role: 'MANAGER', email: { $ne: null } }).select('email').lean();
  const mAbsent = absent.filter((p) => ['HR', 'EMPLOYEE'].includes(p.role));
  for (const m of managers) await digest([m.email], mAbsent, 'Everyone under you');
  const hrs = await M.User.find({ status: 'ACTIVE', role: 'HR', email: { $ne: null } }).select('email department').lean();
  for (const h of hrs) {
    const mine = absent.filter((p) => p.role === 'EMPLOYEE' && (String(p.hr) === String(h._id) || (h.department && String(p.department) === String(h.department))));
    if (mine.length) await digest([h.email], mine, 'Your people');
  }
  return { date: today, absent: absent.length, personalEmails: personal };
}

/** End-of-day summary to Admin + COO. */
export async function sendDailySummary() {
  const today = dateKey();
  const people = await M.User.find({ status: 'ACTIVE', role: { $ne: 'ADMIN' } }).select('name employeeId role').lean();
  const recs = await M.Attendance.find({ date: today, status: 'ACTIVE', user: { $in: people.map((p) => p._id) } }).lean();
  const present = new Set(recs.map((r) => String(r.user)));
  const absent = people.filter((p) => !present.has(String(p._id)));
  const outside = recs.filter((r) => r.sessions.some((x) => x.inGeo?.verified === false)).length;
  const auto = recs.filter((r) => r.sessions.some((x) => x.autoCheckout)).length;
  const totalHrs = Math.round(recs.reduce((a, r) => a + hoursOf(r), 0) * 100) / 100;
  const cfg = await getSettings();
  const late = recs.filter((r) => dayFlags(r, cfg).late).length;
  const pending = await M.ChangeRequest.countDocuments({ status: { $in: ['PENDING_HR', 'PENDING_MANAGER', 'PENDING_COO', 'PENDING_ADMIN'] } });
  const list = absent.slice(0, 40).map((p) => idOf(p)).join(', ') + (absent.length > 40 ? ` and ${absent.length - 40} more` : '');
  const m = layout({
    tone: 'info', title: `Attendance summary: ${dayLabel(today)}`, intro: `${present.size} of ${people.length} people were present today.`,
    rows: [['Present', present.size], ['Absent', absent.length ? list : 'None'], ['Checked in late', late], ['Total hours worked', hm(totalHrs)], ['Check-ins outside the geofence', outside], ['Left the office (auto check-out)', auto], ['Requests waiting for approval', pending]],
    link: link('/'), linkText: 'Open dashboard',
  });
  const r = await sendMail({ to: await leadership(), subject: `Attendance summary ${today}: ${present.size}/${people.length} present`, ...m });
  return { date: today, present: present.size, total: people.length, ...r };
}
