import { getSettings, M } from '@/lib/db';
import { handler, readJson, bad, requireReason } from '@/lib/http';
import { audit } from '@/lib/audit';
import { SCRIPT_URL_RE } from '@/lib/sheets';
import { mailConfigured } from '@/lib/mailer';
import { HHMM, toMin } from '@/lib/hours';

// The Apps Script secret is never sent to the browser here (only via the admin-only /api/sheets/script).
const pick = (s) => ({ workStart: s.workStart || '10:00', workEnd: s.workEnd || '18:00', graceMinutes: s.graceMinutes || 0, lunchStart: s.lunchStart || '13:30', lunchEnd: s.lunchEnd || '14:30', defaultRadiusMeters: s.defaultRadiusMeters, enforceGeofence: s.enforceGeofence, radiusConfigured: s.radiusConfigured,
  sheetScriptUrl: s.sheetScriptUrl, hasSheetSecret: !!s.sheetScriptSecret, sheetTab: s.sheetTab, notificationEmail: s.notificationEmail,
  lastSheetSync: s.lastSheetSync, lastSheetError: s.lastSheetError, lastSheetErrorAt: s.lastSheetErrorAt,
  lastMailError: s.lastMailError, mailEveryCheckin: !!s.mailEveryCheckin, lastMailErrorAt: s.lastMailErrorAt, mailConfigured: mailConfigured() });

export const GET = handler(async () => ({ settings: pick(await getSettings()) }), { roles: ['ADMIN'] });

export const PATCH = handler(async (ctx) => {
  const b = await readJson(ctx.req);
  requireReason(b.reason);
  const cur = await getSettings();
  const upd = {};
  if (b.defaultRadiusMeters !== undefined) {
    const n = Number(b.defaultRadiusMeters);
    if (!Number.isFinite(n) || n < 1 || n > 5000) throw bad('Radius must be between 1 and 5000 metres');
    upd.defaultRadiusMeters = n; upd.radiusConfigured = true;
  }
  if (b.enforceGeofence !== undefined) { upd.enforceGeofence = !!b.enforceGeofence; upd.radiusConfigured = true; }
  if (b.sheetScriptUrl !== undefined) {
    const u = String(b.sheetScriptUrl).trim();
    if (u && !SCRIPT_URL_RE.test(u)) throw bad('Paste the Web app URL from Apps Script (it starts with https://script.google.com/macros/s/ and ends with /exec)');
    upd.sheetScriptUrl = u || null;
  }
  if (b.workStart !== undefined || b.workEnd !== undefined || b.graceMinutes !== undefined) {
    const ws = b.workStart ?? cur.workStart ?? '10:00', we = b.workEnd ?? cur.workEnd ?? '18:00', g = Number(b.graceMinutes ?? cur.graceMinutes ?? 0);
    if (!HHMM.test(ws) || !HHMM.test(we)) throw bad('Office times must look like 10:00 and 18:00');
    if (toMin(we) <= toMin(ws)) throw bad('Office end time must be after the start time');
    if (!Number.isFinite(g) || g < 0 || g > 180) throw bad('Grace period must be between 0 and 180 minutes');
    upd.workStart = ws; upd.workEnd = we; upd.graceMinutes = g;
  }
  if (b.lunchStart !== undefined || b.lunchEnd !== undefined) {
    const ls = b.lunchStart ?? cur.lunchStart ?? '13:30', le = b.lunchEnd ?? cur.lunchEnd ?? '14:30';
    if (!HHMM.test(ls) || !HHMM.test(le) || toMin(le) <= toMin(ls)) throw bad('Lunch must look like 13:30 to 14:30, with the end after the start');
    upd.lunchStart = ls; upd.lunchEnd = le;
  }
  if (b.mailEveryCheckin !== undefined) upd.mailEveryCheckin = !!b.mailEveryCheckin;
  if (b.sheetTab !== undefined) upd.sheetTab = String(b.sheetTab).trim() || 'Attendance';
  if (b.notificationEmail !== undefined) {
    const e = String(b.notificationEmail).trim();
    if (e && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e)) throw bad('Invalid notification email');
    upd.notificationEmail = e || null;
  }
  const next = await M.Setting.findOneAndUpdate({ key: 'system' }, { $set: upd }, { new: true }).lean();
  await audit(ctx, { action: 'CHANGED_SETTINGS', entityType: 'Setting', entityId: 'system', oldData: pick(cur), newData: pick(next), reason: b.reason });
  return { settings: pick(next) };
}, { roles: ['ADMIN'] });
