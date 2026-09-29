// Who can an actor see/oversee? (pure function, shared by users.js and the mailer)
export function scopeFilter(actor) {
  if (actor.role === 'ADMIN') return {};
  // Managers/HR see people assigned to them plus employees of their own department.
  const dept = actor.department ? [{ role: 'EMPLOYEE', department: actor.department }] : [];
  // COO oversees everyone except Admin; a Manager oversees every HR and Employee.
  if (actor.role === 'COO') return { role: { $ne: 'ADMIN' } };
  if (actor.role === 'MANAGER') return { $or: [{ _id: actor._id }, { role: { $in: ['HR', 'EMPLOYEE'] } }] };
  if (actor.role === 'HR') return { $or: [{ _id: actor._id }, { hr: actor._id }, ...dept] };
  return { _id: actor._id };
}
