import { hoursWorked } from './attendance.js';

const t = (d) => (d ? new Date(d).toISOString().replace('T', ' ').slice(0, 19) + ' UTC' : '');

export function attendanceRows(recs) {
  const rows = [['Date', 'Employee ID', 'Employee', 'Location', 'Status', 'Sessions', 'First check-in', 'Last check-out', 'Hours', 'Void reason']];
  for (const r of recs) {
    const s = r.sessions || [];
    rows.push([r.date, r.user?.employeeId || '', r.user?.name || '', r.location?.name || '', r.status, s.length,
      t(s[0]?.checkIn), t(s.filter((x) => x.checkOut).at(-1)?.checkOut), hoursWorked(r), r.voidReason || '']);
  }
  return rows;
}
