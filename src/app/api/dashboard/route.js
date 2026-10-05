import { M, getSettings } from '@/lib/db';
import { handler } from '@/lib/http';
import { dateKey } from '@/lib/dates';
import { completion, scopeFilter } from '@/lib/users';
import { photosEnabled, photoUrl } from '@/lib/cloudinary';
import { hoursWorked } from '@/lib/attendance';
import { canActOn } from '@/lib/workflow';
import { afterHours, dayFlags, hoursCfg } from '@/lib/hours';

const PENDING = ['PENDING_HR', 'PENDING_MANAGER', 'PENDING_COO', 'PENDING_ADMIN'];

async function overview(user, today, cfg) {
  // Everyone this user oversees (Admin: everyone except Admin accounts).
  const team = await M.User.find({ $and: [scopeFilter(user), { status: 'ACTIVE', role: { $ne: 'ADMIN' }, _id: { $ne: user._id } }] })
    .populate('department', 'name').lean();
  const ids = team.map((u) => u._id);
  const byId = Object.fromEntries(team.map((u) => [String(u._id), u]));

  const recs = await M.Attendance.find({ user: { $in: ids }, date: today, status: 'ACTIVE' }).lean();
  const present = recs.map((r) => {
    const u = byId[String(r.user)];
    const first = r.sessions[0], last = r.sessions.at(-1);
    return {
      id: String(r._id), name: u?.name, employeeId: u?.employeeId, role: u?.role,
      checkIn: first?.checkIn, checkOut: last?.checkOut, open: r.sessions.some((s) => !s.checkOut),
      outside: r.sessions.some((s) => s.inGeo?.verified === false), auto: r.sessions.some((s) => s.autoCheckout),
      photo: photoUrl(first?.inPhoto), flags: dayFlags(r, cfg),
    };
  }).sort((a, b) => new Date(b.checkIn) - new Date(a.checkIn));
  const presentIds = new Set(recs.map((r) => String(r.user)));
  const absent = team.filter((u) => !presentIds.has(String(u._id)))
    .map((u) => ({ id: String(u._id), name: u.name, employeeId: u.employeeId, role: u.role, department: u.department?.name }));

  // Requests waiting on this user (Admin sees every pending request).
  const pendingRaw = await M.ChangeRequest.find({ status: { $in: PENDING }, ...(user.role === 'ADMIN' ? {} : { subject: { $in: ids } }) })
    .sort({ createdAt: 1 }).populate('requester', 'name role').populate('subject', 'name employeeId hr manager').lean();
  const actionable = pendingRaw.filter((r) => user.role === 'ADMIN' || canActOn(user, { ...r, requester: r.requester._id }, r.subject));

  const deptCount = {};
  for (const u of team) { const n = u.department?.name || 'No department'; deptCount[n] = (deptCount[n] || 0) + 1; }
  const roleCount = (role) => team.filter((u) => u.role === role).length;

  const o = {
    counts: {
      team: team.length, coo: roleCount('COO'), managers: roleCount('MANAGER'), hr: roleCount('HR'), employees: roleCount('EMPLOYEE'),
      presentToday: present.length, checkedInNow: present.filter((p) => p.open).length, absentToday: absent.length,
      pendingRequests: actionable.length,
    },
    present: present.slice(0, 8),
    absent: absent.slice(0, 8),
    pending: actionable.slice(0, 5).map((r) => ({
      id: String(r._id), type: r.type, status: r.status, requester: r.requester?.name, requesterRole: r.requester?.role,
      subject: r.subject?.name, reason: r.reason, at: r.createdAt,
    })),
    attention: {
      noManager: team.filter((u) => u.role === 'EMPLOYEE' && !u.manager).length,
      incompleteProfiles: team.filter((u) => completion(u).percent < 100).length,
      outsideToday: present.filter((p) => p.outside).length,
      lateToday: present.filter((p) => p.flags.late).length,
      autoCheckoutToday: present.filter((p) => p.auto).length,
    },
    departments: Object.entries(deptCount).map(([name, n]) => ({ name, n })).sort((a, b) => b.n - a.n),
  };

  if (user.role === 'ADMIN') {
    const logs = await M.AuditLog.find().sort({ at: -1 }).limit(8).lean();
    const subs = await M.User.find({ _id: { $in: logs.map((l) => l.subjectId).filter(Boolean) } }).select('name').lean();
    const sm = Object.fromEntries(subs.map((s) => [String(s._id), s.name]));
    o.activity = logs.map((l) => ({ at: l.at, action: l.action, actor: l.actorEmail, subject: sm[String(l.subjectId)], override: l.override }));
  }
  return o;
}

export const GET = handler(async ({ user }) => {
  const today = dateKey();
  const out = { role: user.role };

  const mine = await M.Attendance.findOne({ user: user._id, date: today }).lean();
  const open = await M.Attendance.findOne({ user: user._id, status: 'ACTIVE', 'sessions.checkOut': null }).lean();
  out.today = {
    date: today, record: mine, checkedIn: !!open, hours: mine ? hoursWorked(mine) : 0,
    locationAssigned: !!user.location, photosRequired: photosEnabled(),
    // Left the premises earlier today: a reason is needed to check in again.
    needsReason: !!(mine?.status === 'ACTIVE' && mine.sessions.at(-1)?.autoCheckout && mine.sessions.at(-1)?.checkOut),
    leftAt: mine?.sessions.at(-1)?.autoCheckout ? mine.sessions.at(-1).checkOut : undefined,
  };
  if (user.location) out.today.location = await M.Location.findById(user.location).select('name latitude longitude radiusMeters').lean();
  out.completion = completion(user);

  if (user.role !== 'ADMIN') {
    const recent = await M.Attendance.find({ user: user._id }).sort({ date: -1 }).limit(7).lean();
    out.recent = recent.map((r) => ({ date: r.date, status: r.status, hours: hoursWorked(r), in: r.sessions[0]?.checkIn, out: r.sessions.at(-1)?.checkOut }));
    out.myPending = await M.ChangeRequest.countDocuments({ requester: user._id, status: { $in: PENDING } });
  }

  const cfgSettings = await getSettings();
  out.office = hoursCfg(cfgSettings);
  // Once office hours are over, "not checked in" becomes "absent" (Sunday is the weekly off).
  out.today.closed = afterHours(cfgSettings);
  out.today.weekOff = new Date(`${today}T00:00:00Z`).getUTCDay() === 0;
  if (mine) out.today.flags = dayFlags(mine, cfgSettings);
  if (user.role !== 'EMPLOYEE') out.overview = await overview(user, today, cfgSettings);

  if (user.role === 'ADMIN') {
    const [coo, managers, hr, employees, locations, s] = await Promise.all([
      M.User.countDocuments({ role: 'COO', status: 'ACTIVE' }),
      M.User.countDocuments({ role: 'MANAGER', status: 'ACTIVE' }), M.User.countDocuments({ role: 'HR', status: 'ACTIVE' }),
      M.User.countDocuments({ role: 'EMPLOYEE', status: 'ACTIVE' }), M.Location.countDocuments({ status: 'ACTIVE' }), getSettings(),
    ]);
    out.checklist = [
      { key: 'admin', label: 'Admin account configured', done: true },
      { key: 'coo', label: 'Add COO', done: coo > 0, href: '/users/new?role=COO' },
      { key: 'manager', label: 'Add Manager', done: managers > 0, href: '/users/new?role=MANAGER' },
      { key: 'hr', label: 'Add HR', done: hr > 0, href: '/users/new?role=HR' },
      { key: 'employees', label: 'Add Employees', done: employees > 0, href: '/users/new?role=EMPLOYEE' },
      { key: 'location', label: 'Configure Location', done: locations > 0, href: '/locations' },
      { key: 'radius', label: 'Configure Attendance Radius', done: !!s.radiusConfigured, href: '/settings' },
      { key: 'sheets', label: 'Connect Google Sheets', done: !!s.sheetScriptUrl, href: '/settings' },
      { key: 'notify', label: 'Configure Notifications', done: !!s.notificationEmail, href: '/settings' },
    ];
  }
  return out;
});
