// Google Sheets via a Google Apps Script web app that the admin deploys from their own sheet.
// One-way reporting copy: MongoDB stays authoritative and nothing is read back into the app.

import { dayFlags, minutesText } from './hours.js';

export const SCRIPT_URL_RE = /^https:\/\/script\.google\.com\/macros\/s\/[\w-]+\/exec$/;
export const sheetsConfigured = (s) => !!(s?.sheetScriptUrl && s?.sheetScriptSecret);

export const HEADER = ['Key', 'Date', 'Employee ID', 'Name', 'Role', 'Location', 'Status', 'First check-in', 'Last check-out', 'Hours', 'Sessions',
  'Reasons for re-entry', 'Notes', 'Updated'];
const ist = (d) => (d ? new Date(d).toLocaleTimeString('en-IN', { timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit', hour12: true }) : '');

export function rowFor(rec, hours, cfg) {
  const f = cfg ? dayFlags(rec, cfg) : null;
  const s = rec.sessions || [];
  const outs = s.filter((x) => x.checkOut);
  const notes = [
    f?.late && `late by ${minutesText(f.lateMinutes)}`,
    f?.early && `left ${minutesText(f.earlyMinutes)} early`,
    s.some((x) => x.autoCheckout) && 'left premises (auto check-out)',
    s.some((x) => x.inGeo?.verified === false) && 'check-in outside geofence',
    s.some((x) => x.corrected) && 'corrected by admin',
    rec.status === 'VOIDED' && `VOIDED: ${rec.voidReason || ''}`,
  ].filter(Boolean).join('; ');
  return [
    `${rec.date}|${rec.user?.employeeId || rec.user}`, rec.date, rec.user?.employeeId || '', rec.user?.name || '', rec.user?.role || '', rec.location?.name || '',
    rec.status, ist(s[0]?.checkIn), ist(outs.at(-1)?.checkOut), hours,
    s.map((x) => `${ist(x.checkIn)}-${x.checkOut ? ist(x.checkOut) + (x.autoCheckout ? ' (auto)' : '') : 'open'}`).join(' | '),
    s.filter((x) => x.reentryReason).map((x) => `${ist(x.checkIn)}: ${x.reentryReason}`).join(' | '),
    notes, new Date().toISOString(),
  ];
}

async function post(settings, payload) {
  if (!sheetsConfigured(settings)) throw new Error('Google Sheets is not connected yet');
  if (!SCRIPT_URL_RE.test(settings.sheetScriptUrl)) throw new Error('The Apps Script URL is not valid');
  const res = await fetch(settings.sheetScriptUrl, {
    method: 'POST', redirect: 'follow', signal: AbortSignal.timeout(25000),
    headers: { 'content-type': 'text/plain;charset=utf-8' }, // text/plain avoids a CORS preflight on Apps Script
    body: JSON.stringify({ secret: settings.sheetScriptSecret, tab: settings.sheetTab || 'Attendance', header: HEADER, ...payload }),
  });
  const text = await res.text();
  let out;
  try { out = JSON.parse(text); } catch {
    throw new Error('The Apps Script did not answer correctly. Re-deploy it as a Web app with access set to "Anyone" and paste the new /exec URL.');
  }
  if (!out.ok) throw new Error(`Apps Script: ${out.error || 'request failed'}`);
  return out;
}

export const pingScript = (settings) => post(settings, { action: 'ping' });
export const upsertRow = (settings, row) => post(settings, { action: 'upsert', rows: [row] });
/** Rewrite the whole tab (backfill). */
export const replaceRows = (settings, rows) => post(settings, { action: 'replace', rows });

/** The script the admin pastes into Extensions > Apps Script. The secret is baked in. */
export function appsScriptSource(secret) {
  return `// Shine Attendance: receives attendance rows from the app and writes them to this spreadsheet.
const SECRET = '${secret}';

function doPost(e) {
  const lock = LockService.getScriptLock();
  try {
    const d = JSON.parse(e.postData.contents);
    if (d.secret !== SECRET) return out({ ok: false, error: 'wrong secret' });
    lock.waitLock(20000);
    const ss = SpreadsheetApp.getActiveSpreadsheet();
    const sh = ss.getSheetByName(d.tab) || ss.insertSheet(d.tab);
    const width = d.header.length;
    if (sh.getRange(1, 1).getValue() !== 'Key') {
      sh.getRange(1, 1, 1, width).setValues([d.header]).setFontWeight('bold');
      sh.setFrozenRows(1);
    }
    if (d.action === 'ping') return out({ ok: true, title: ss.getName(), tab: d.tab });

    if (d.action === 'replace') {
      if (sh.getLastRow() > 1) sh.getRange(2, 1, sh.getLastRow() - 1, width).clearContent();
      if (d.rows.length) write(sh, 2, d.rows, width);
      return out({ ok: true, rows: d.rows.length });
    }
    // upsert: one row per Key (date|employee id)
    const last = sh.getLastRow();
    const keys = last > 1 ? sh.getRange(2, 1, last - 1, 1).getValues().map(String_) : [];
    d.rows.forEach(function (row) {
      const i = keys.lastIndexOf(String(row[0]));
      if (i >= 0) write(sh, i + 2, [row], width);
      else { write(sh, sh.getLastRow() + 1, [row], width); keys.push(String(row[0])); }
    });
    return out({ ok: true, rows: d.rows.length });
  } catch (err) {
    return out({ ok: false, error: String(err) });
  } finally {
    try { lock.releaseLock(); } catch (x) {}
  }
}

function String_(r) { return String(r[0]); }
function write(sh, startRow, rows, width) {
  // Force plain text so dates/times are not reinterpreted and nothing is treated as a formula.
  const range = sh.getRange(startRow, 1, rows.length, width);
  range.setNumberFormat('@');
  range.setValues(rows.map(function (r) { return r.map(function (v) { v = v == null ? '' : String(v); return /^[=+\\-@]/.test(v) ? "'" + v : v; }); }));
}
function out(o) { return ContentService.createTextOutput(JSON.stringify(o)).setMimeType(ContentService.MimeType.JSON); }
`;
}

// ---- Employees tab: one row per person (Admin accounts excluded), keyed by employee ID ----
export const EMP_TAB = 'Employees';
export const EMP_HEADER = ['Key', 'Name', 'Role', 'Designation', 'Department', 'Manager / reports to', 'HR', 'Location', 'Status', 'Email', 'Mobile',
  'Joining date', 'Employee type', "Father's name", "Mother's name", 'Date of birth', 'Address', 'City', 'State', 'PIN code',
  'Emergency contact 1', 'Emergency contact 2', 'Updated'];
const contact = (c) => (c && (c.name || c.mobile) ? [c.name, c.relationship && `(${c.relationship})`, c.mobile].filter(Boolean).join(' ') : '');

/** `u` must have department/manager/hr/location populated with { name }. Column A (Key) is the employee ID. */
export function employeeRow(u) {
  return [
    u.employeeId || String(u._id), u.name, u.role, u.designation || '', u.department?.name || '', u.manager?.name || '', u.hr?.name || '', u.location?.name || '',
    u.status, u.email || '', u.mobile || '', u.joiningDate || '', u.employeeType || '', u.fatherName || '', u.motherName || '', u.dob || '',
    u.address || '', u.city || '', u.state || '', u.pincode || '', contact(u.emergencyContact1), contact(u.emergencyContact2), new Date().toISOString(),
  ];
}
export const upsertEmployee = (settings, row) => post(settings, { action: 'upsert', tab: EMP_TAB, header: EMP_HEADER, rows: [row] });
export const replaceEmployees = (settings, rows) => post(settings, { action: 'replace', tab: EMP_TAB, header: EMP_HEADER, rows });

// ---- Tasks tab: one row per task, keyed by task id ----
export const TASK_TAB = 'Tasks';
export const TASK_HEADER = ['Key', 'Date', 'Employee ID', 'Name', 'Task', 'Details', 'Assigned by', 'Status', 'Score', 'Late submission', 'HR note', 'Updated by', 'Updated'];

/** `t` must have user / assignedBy / reviewedBy populated with { name, employeeId }. */
export function taskRow(t, label, score) {
  return [
    String(t._id), t.date, t.user?.employeeId || '', t.user?.name || '', t.title, t.details || '', t.assignedBy?.name || '',
    label, score, t.late ? 'Yes' : 'No', t.note || '', t.reviewedBy?.name || '', new Date().toISOString(),
  ];
}
export const upsertTask = (settings, row) => post(settings, { action: 'upsert', tab: TASK_TAB, header: TASK_HEADER, rows: [row] });
export const replaceTasks = (settings, rows) => post(settings, { action: 'replace', tab: TASK_TAB, header: TASK_HEADER, rows });
