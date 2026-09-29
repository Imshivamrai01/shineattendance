import { after } from 'next/server';
import { M, getSettings } from './db.js';
import { rowFor, upsertRow, sheetsConfigured, employeeRow, upsertEmployee } from './sheets.js';

const hoursWorked = (rec) => Math.round(((rec.sessions || []).reduce((ms, s) => ms + (s.checkIn && s.checkOut ? new Date(s.checkOut) - new Date(s.checkIn) : 0), 0) / 3600000) * 100) / 100;

async function run(recId) {
  try {
    const s = await getSettings();
    if (!sheetsConfigured(s)) return;
    const rec = await M.Attendance.findById(recId).populate('user', 'name employeeId role').populate('location', 'name').lean();
    if (!rec) return;
    await upsertRow(s, rowFor(rec, rec.status === 'ACTIVE' ? hoursWorked(rec) : 0, rec.status === 'ACTIVE' ? s : null));
    await M.Setting.updateOne({ key: 'system' }, { $set: { lastSheetSync: new Date() }, $unset: { lastSheetError: '', lastSheetErrorAt: '' } });
  } catch (e) {
    // Sheets is only a reporting copy: never let it affect attendance. Surface the error in Settings.
    console.error('Sheets sync failed:', e.message);
    await M.Setting.updateOne({ key: 'system' }, { $set: { lastSheetError: String(e.message).slice(0, 400), lastSheetErrorAt: new Date() } }).catch(() => {});
  }
}

/** Sync one attendance record to Google Sheets after the response is sent. */
export function queueSheetSync(recId) {
  const id = String(recId);
  try { after(() => run(id)); } catch { run(id); }
}

async function runEmployee(userId) {
  try {
    const s = await getSettings();
    if (!sheetsConfigured(s)) return;
    const u = await M.User.findById(userId).populate('department', 'name').populate('manager', 'name').populate('hr', 'name').populate('location', 'name').lean();
    if (!u || u.role === 'ADMIN') return;
    await upsertEmployee(s, employeeRow(u));
    await M.Setting.updateOne({ key: 'system' }, { $set: { lastSheetSync: new Date() }, $unset: { lastSheetError: '', lastSheetErrorAt: '' } });
  } catch (e) {
    console.error('Sheets employee sync failed:', e.message);
    await M.Setting.updateOne({ key: 'system' }, { $set: { lastSheetError: String(e.message).slice(0, 400), lastSheetErrorAt: new Date() } }).catch(() => {});
  }
}

/** Sync one person's profile row to the Employees tab after the response is sent. */
export function queueEmployeeSync(userId) {
  const id = String(userId);
  try { after(() => runEmployee(id)); } catch { runEmployee(id); }
}
