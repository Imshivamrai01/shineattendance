import { M, getSettings } from '@/lib/db';
import { handler, readJson, bad } from '@/lib/http';
import { audit } from '@/lib/audit';
import { checkAccount } from '@/lib/whatsapp';

// Save the WhatsApp Cloud API details. They are checked against Meta first; the token is stored server-side only.
export const POST = handler(async (ctx) => {
  const b = await readJson(ctx.req);
  const cur = await getSettings();
  const next = {
    waPhoneId: String(b.phoneId ?? '').trim(), waBusinessId: String(b.businessId ?? '').trim(),
    waToken: String(b.token ?? '').trim() || cur.waToken, // leave blank to keep the saved token
    waAppSecret: String(b.appSecret ?? '').trim() || cur.waAppSecret || '', // optional: checks that webhook calls really come from Meta
  };
  if (next.waAppSecret && !/^[a-f0-9]{32}$/i.test(next.waAppSecret)) throw bad('The App secret is a 32-character code from App settings → Basic');
  if (!/^\d{6,25}$/.test(next.waPhoneId)) throw bad('Phone number ID is the long number shown under your number in the Meta dashboard');
  if (next.waBusinessId && !/^\d{6,25}$/.test(next.waBusinessId)) throw bad('WhatsApp Business Account ID is a long number. Leave it empty to find it automatically.');
  if (!next.waToken || next.waToken.length < 50) throw bad('Paste the access token');
  let account, found;
  try { ({ account, businessId: found } = await checkAccount(next)); } catch (e) { throw bad(e.message); }
  const corrected = found !== next.waBusinessId;
  next.waBusinessId = found; // the account that really holds this number (found from the token when empty or wrong)
  await M.Setting.updateOne({ key: 'system' }, { $set: next });
  await audit(ctx, { action: 'CHANGED_WHATSAPP_SETTINGS', entityType: 'Setting', entityId: 'whatsapp',
    oldData: { phoneId: cur.waPhoneId, businessId: cur.waBusinessId }, newData: { phoneId: next.waPhoneId, businessId: next.waBusinessId, tokenChanged: next.waToken !== cur.waToken, appSecretChanged: next.waAppSecret !== (cur.waAppSecret || ''), number: account.number } });
  return { ok: true, account, businessId: next.waBusinessId, corrected };
}, { roles: ['ADMIN', 'COO'] });
