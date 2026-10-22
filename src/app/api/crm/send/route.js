import crypto from 'node:crypto';
import { M, getSettings } from '@/lib/db';
import { handler, readJson, bad, oid } from '@/lib/http';
import { audit } from '@/lib/audit';
import { normalizePhone, sendTemplate, waConfigured } from '@/lib/whatsapp';

const MAX = 25; // per request; the page sends a long list in chunks so progress is visible
const PURPOSES = ['INTERVIEW', 'WELCOME', 'BULK', 'OFFER', 'SALES', 'FEEDBACK'];

// Send one approved template to up to 25 people. Each recipient carries the final values for the template's variables.
export const POST = handler(async (ctx) => {
  const b = await readJson(ctx.req);
  const s = await getSettings();
  if (!waConfigured(s)) throw bad('Connect WhatsApp first');
  const template = String(b.template || '').trim(), language = String(b.language || 'en').trim();
  if (!/^[a-z0-9_]{1,512}$/.test(template)) throw bad('Choose a template');
  if (!Array.isArray(b.recipients) || !b.recipients.length) throw bad('Add at least one recipient');
  if (b.recipients.length > MAX) throw bad(`Send at most ${MAX} recipients per request`);
  const batch = /^[\w-]{6,40}$/.test(b.batch || '') ? b.batch : crypto.randomUUID();
  const purpose = PURPOSES.includes(b.purpose) ? b.purpose : 'BULK';
  // Header: a file from the media library (image / video / PDF), or the value of a text header. Same for everyone.
  let header, mediaName;
  if (b.header?.mediaId) {
    const item = await M.WaMedia.findById(oid(b.header.mediaId, 'file')).lean();
    if (!item || item.expiresAt < new Date()) throw bad('That file has expired at WhatsApp (they keep files for 30 days). Upload it again in the media library.');
    header = { type: item.kind.toLowerCase(), id: item.waMediaId, filename: item.name };
    mediaName = item.name;
  } else if (b.header?.text) header = { type: 'text', text: String(b.header.text).slice(0, 60) };
  // Values for link buttons ending in {{1}}: [{ index, text }]
  const buttonParams = Array.isArray(b.buttons) ? b.buttons.slice(0, 2).filter((x) => x && String(x.text || '').trim()).map((x) => ({ index: Number(x.index) || 0, text: String(x.text).slice(0, 500) })) : [];

  const results = [];
  for (const r of b.recipients) {
    const name = String(r?.name || '').trim().slice(0, 120);
    const params = Array.isArray(r?.params) ? r.params.slice(0, 20).map((p) => String(p ?? '').slice(0, 1000)) : [];
    const to = normalizePhone(r?.phone);
    const log = { batch, purpose, to: to || String(r?.phone || '').slice(0, 30), name, user: /^[a-f\d]{24}$/i.test(r?.userId || '') ? r.userId : undefined, template, language, params, media: mediaName, sentBy: ctx.user._id };
    if (!to) { results.push(await M.WaMessage.create({ ...log, status: 'FAILED', error: 'Not a valid mobile number' })); continue; }
    try {
      results.push(await M.WaMessage.create({ ...log, status: 'SENT', waId: await sendTemplate(s, { to, template, language, params, header, buttonParams }) }));
    } catch (e) {
      results.push(await M.WaMessage.create({ ...log, status: 'FAILED', error: String(e.message).slice(0, 300) }));
    }
  }
  const sent = results.filter((x) => x.status === 'SENT').length;
  await audit(ctx, { action: 'SENT_WHATSAPP', entityType: 'WaMessage', entityId: batch, newData: { template, purpose, sent, failed: results.length - sent } });
  return { batch, sent, failed: results.length - sent, results: results.map((x) => ({ to: x.to, name: x.name, status: x.status, error: x.error })) };
}, { roles: ['ADMIN', 'COO'] });
