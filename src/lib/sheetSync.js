import { M, getSettings, defer } from './db.js';
import { rowFor, upsertRow, sheetsConfigured, employeeRow, upsertEmployee, taskRow, upsertTask } from './sheets.js';
import { taskLabel, taskScore } from './taskScore.js';

import { workedHours } from './hours.js';

async function run(recId) {
  try {
    const s = await getSettings();
    if (!sheetsConfigured(s)) return;
    const rec = await M.Attendance.findById(recId).populate('user', 'name employeeId role').populate('location', 'name').lean();
    if (!rec) return;
    await upsertRow(s, rowFor(rec, rec.status === 'ACTIVE' ? workedHours(rec, s) : 0, rec.status === 'ACTIVE' ? s : null));
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
  defer(() => run(id));
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
  defer(() => runEmployee(id));
}

const populateTask = (q) => q.populate('user', 'name employeeId').populate('assignedBy', 'name').populate('reviewedBy', 'name');

async function pushTaskRow(row) {
  try {
    const s = await getSettings();
    if (!sheetsConfigured(s)) return;
    await upsertTask(s, row);
    await M.Setting.updateOne({ key: 'system' }, { $set: { lastSheetSync: new Date() }, $unset: { lastSheetError: '', lastSheetErrorAt: '' } });
  } catch (e) {
    console.error('Sheets task sync failed:', e.message);
    await M.Setting.updateOne({ key: 'system' }, { $set: { lastSheetError: String(e.message).slice(0, 400), lastSheetErrorAt: new Date() } }).catch(() => {});
  }
}

/** Sync one task to the Tasks tab after the response is sent. */
export function queueTaskSync(taskId) {
  const id = String(taskId);
  defer(async () => {
    const t = await populateTask(M.Task.findById(id)).lean();
    if (t) await pushTaskRow(taskRow(t, taskLabel(t), taskScore(t)));
  });
}

/** A deleted task stays in the sheet, marked Deleted. `t` = the populated task before deletion. */
export function queueTaskRemoved(t) {
  defer(() => pushTaskRow(taskRow(t, 'Deleted', 0)));
}
export { populateTask };
