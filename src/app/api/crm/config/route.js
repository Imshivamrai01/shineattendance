import { M, getSettings } from '@/lib/db';
import { handler, readJson, bad } from '@/lib/http';
import { audit } from '@/lib/audit';
import { accountInfo } from '@/lib/whatsapp';

// Save the WhatsApp Cloud API details. They are checked against Meta first; the token is stored server-side only.
export const POST = handler(async (ctx) => {
  const b = await readJson(ctx.req);
  const cur = await getSettings();
  const next = {
    waPhoneId: String(b.phoneId ?? '').trim(), waBusinessId: String(b.businessId ?? '').trim(),
    waToken: String(b.token ?? '').trim() || cur.waToken, // leave blank to keep the saved token
  };
  if (!/^\d{6,25}$/.test(next.waPhoneId) || !/^\d{6,25}$/.test(next.waBusinessId)) throw bad('Phone number ID and WhatsApp Business Account ID are the long numbers from the Meta dashboard');
  if (!next.waToken || next.waToken.length < 50) throw bad('Paste the access token');
  let account;
  try { account = await accountInfo(next); } catch (e) { throw bad(e.message); }
  await M.Setting.updateOne({ key: 'system' }, { $set: next });
  await audit(ctx, { action: 'CHANGED_WHATSAPP_SETTINGS', entityType: 'Setting', entityId: 'whatsapp',
    oldData: { phoneId: cur.waPhoneId, businessId: cur.waBusinessId }, newData: { phoneId: next.waPhoneId, businessId: next.waBusinessId, tokenChanged: next.waToken !== cur.waToken, number: account.number } });
  return { ok: true, account };
}, { roles: ['ADMIN', 'COO'] });
