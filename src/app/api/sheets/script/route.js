import crypto from 'node:crypto';
import { M, getSettings } from '@/lib/db';
import { handler } from '@/lib/http';
import { audit } from '@/lib/audit';
import { appsScriptSource } from '@/lib/sheets';

// Returns the Apps Script source to paste into the sheet. Creates the shared secret on first use.
export const GET = handler(async (ctx) => {
  let s = await getSettings();
  if (!s.sheetScriptSecret) {
    s = await M.Setting.findOneAndUpdate({ key: 'system' }, { $set: { sheetScriptSecret: crypto.randomBytes(24).toString('hex') } }, { new: true }).lean();
  }
  await audit(ctx, { action: 'VIEWED_SHEETS_SCRIPT', entityType: 'Setting', entityId: 'sheets' });
  return { script: appsScriptSource(s.sheetScriptSecret) };
}, { roles: ['ADMIN'] });

// Rotate the secret (the old deployed script stops working until the new script is pasted in).
export const POST = handler(async (ctx) => {
  const s = await M.Setting.findOneAndUpdate({ key: 'system' }, { $set: { sheetScriptSecret: crypto.randomBytes(24).toString('hex') } }, { new: true, upsert: true }).lean();
  await audit(ctx, { action: 'ROTATED_SHEETS_SECRET', entityType: 'Setting', entityId: 'sheets' });
  return { script: appsScriptSource(s.sheetScriptSecret) };
}, { roles: ['ADMIN'] });
