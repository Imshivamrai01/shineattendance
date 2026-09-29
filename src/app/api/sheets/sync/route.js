import { M, getSettings } from '@/lib/db';
import { handler, bad, HttpError } from '@/lib/http';
import { audit } from '@/lib/audit';
import { replaceRows, replaceEmployees, employeeRow, rowFor, sheetsConfigured } from '@/lib/sheets';
import { hoursWorked } from '@/lib/attendance';
import { queryAttendance } from '@/lib/attendanceQuery';

// Backfill: rewrite the tab from MongoDB. Day-to-day updates happen automatically per check-in/out.
export const POST = handler(async (ctx) => {
  const s = await getSettings();
  if (!sheetsConfigured(s)) throw bad('Connect Google Sheets first');
  const recs = await queryAttendance(ctx.user, new URLSearchParams({ from: '2000-01-01' }));
  const rows = recs.map((r) => rowFor(r, r.status === 'ACTIVE' ? hoursWorked(r) : 0, r.status === 'ACTIVE' ? s : null)).reverse();
  const people = await M.User.find({ role: { $ne: 'ADMIN' } }).sort({ name: 1 }).populate('department', 'name').populate('manager', 'name').populate('hr', 'name').populate('location', 'name').lean();
  try {
    await replaceRows(s, rows);
    await replaceEmployees(s, people.map(employeeRow));
  } catch (e) {
    // The sync layer failing must never affect MongoDB data.
    throw new HttpError(502, e.message);
  }
  await M.Setting.updateOne({ key: 'system' }, { $set: { lastSheetSync: new Date() }, $unset: { lastSheetError: '', lastSheetErrorAt: '' } });
  await audit(ctx, { action: 'SYNCED_SHEETS', entityType: 'Setting', entityId: 'sheets', newData: { rows: rows.length, employees: people.length } });
  return { ok: true, rows: rows.length, employees: people.length };
}, { roles: ['ADMIN'] });
