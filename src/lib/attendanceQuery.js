import { M } from './db.js';
import { scopeFilter } from './users.js';
import { dateKey } from './dates.js';

export async function queryAttendance(user, sp) {
  const to = sp.get('to') || dateKey();
  const from = sp.get('from') || dateKey(new Date(Date.now() - 29 * 86400000));
  // review=1: every record still waiting for a reviewer, whatever its date
  const review = sp.get('review') === '1';
  const q = review ? { 'sessions.checks.status': 'REVIEW_REQUIRED', status: 'ACTIVE' } : { date: { $gte: from, $lte: to } };
  const visible = await M.User.find(scopeFilter(user)).distinct('_id');
  const role = sp.get('role');
  if (role) { const ok = new Set((await M.User.find({ _id: { $in: visible }, role }).distinct('_id')).map(String)); visible.splice(0, visible.length, ...visible.filter((v) => ok.has(String(v)))); }
  const uid = sp.get('userId');
  if (uid) {
    if (!visible.map(String).includes(uid)) return [];
    q.user = uid;
  } else q.user = { $in: visible };
  if (sp.get('status')) q.status = sp.get('status');
  return M.Attendance.find(q).sort({ date: -1 }).limit(2000)
    .populate('user', 'name employeeId department role designation photo hr manager').populate('location', 'name').lean();
}
