import { M } from '@/lib/db';
import { handler } from '@/lib/http';
import { dateKey } from '@/lib/dates';

// Employees for the CRM: who has checked in today, and the latest call to each (with the reason they gave).
export const GET = handler(async () => {
  const today = dateKey();
  const people = await M.User.find({ status: 'ACTIVE', role: { $ne: 'ADMIN' } }).select('name employeeId role mobile designation department')
    .populate('department', 'name').sort({ name: 1 }).lean();
  const ids = people.map((p) => p._id);
  const [att, calls] = await Promise.all([
    M.Attendance.find({ date: today, status: 'ACTIVE', user: { $in: ids } }).select('user sessions').lean(),
    M.StaffCall.aggregate([{ $match: { employee: { $in: ids } } }, { $sort: { createdAt: -1 } }, { $group: { _id: '$employee', c: { $first: '$$ROOT' } } }]),
  ]);
  const inOf = Object.fromEntries(att.map((a) => [String(a.user), a.sessions?.[0]?.checkIn]));
  const callOf = Object.fromEntries(calls.map((x) => [String(x._id), { _id: x.c._id, mode: x.c.mode, status: x.c.status, reason: x.c.reason, at: x.c.createdAt }]));
  return { date: today, employees: people.map((p) => ({ ...p, department: p.department?.name, checkIn: inOf[String(p._id)] || null, lastCall: callOf[String(p._id)] || null })) };
}, { roles: ['ADMIN', 'COO'] });
