import { M, getSettings } from '@/lib/db';
import { handler, readJson, bad } from '@/lib/http';
import { audit } from '@/lib/audit';
import { appIdFor, buildTemplate, createTemplate, mediaKind, MEDIA_RULES, uploadMedia, uploadSample, waConfigured } from '@/lib/whatsapp';

const PURPOSES = ['INTERVIEW', 'WELCOME', 'BULK', 'OFFER', 'SALES', 'FEEDBACK'];

/** A file from the form, checked against what WhatsApp accepts for this header type. */
async function fileFor(form, format) {
  const f = form.get('sample');
  if (!f || typeof f === 'string' || !f.size) return null;
  const kind = mediaKind(f.type);
  if (kind !== format) throw bad(`The header is ${format.toLowerCase()}: attach ${MEDIA_RULES[format].label}`);
  if (f.size > MEDIA_RULES[kind].max) throw bad(`File too big: ${MEDIA_RULES[kind].label}`);
  return { bytes: new Uint8Array(await f.arrayBuffer()), mime: f.type, name: String(f.name || 'file').slice(0, 200), size: f.size };
}

/*
 * Create a template and submit it to Meta for approval (usually minutes, up to a day).
 * JSON { def } for text-only templates, or multipart: field "def" (JSON) + file "sample" for an image / video / PDF header.
 * The sample is what Meta reviews; it is also added to the media library so it can be sent right away.
 */
export const POST = handler(async (ctx) => {
  const s = await getSettings();
  if (!waConfigured(s)) throw bad('Connect WhatsApp first');
  let def, form = null;
  if ((ctx.req.headers.get('content-type') || '').startsWith('multipart/form-data')) {
    form = await ctx.req.formData();
    try { def = JSON.parse(String(form.get('def') || '{}')); } catch { throw bad('Invalid template'); }
  } else def = (await readJson(ctx.req)).def;
  if (!def || typeof def !== 'object') throw bad('Invalid template');
  const format = String(def.header?.format || 'NONE').toUpperCase();
  const media = MEDIA_RULES[format];
  buildTemplate(def, media ? 'check' : undefined); // validate everything before uploading anything

  let handle, file = null, libraryItem = null;
  if (media) {
    file = form && await fileFor(form, format);
    if (!file) throw bad(`Attach a sample ${MEDIA_RULES[format].label}: Meta reviews the template with it`);
    try {
      const appId = await appIdFor(s);
      if (appId !== s.waAppId) await M.Setting.updateOne({ key: 'system' }, { $set: { waAppId: appId } });
      handle = await uploadSample(s, { appId, ...file });
    } catch (e) { throw bad(`Uploading the sample to WhatsApp failed: ${e.message}`); }
  }
  const tpl = buildTemplate(def, handle);
  let out;
  try { out = await createTemplate(s, tpl); } catch (e) { throw bad(e.message); }

  if (file) { // the same file, ready for sending
    try {
      const waMediaId = await uploadMedia(s, file);
      libraryItem = await M.WaMedia.create({ kind: format, name: file.name, mime: file.mime, size: file.size, waMediaId, phoneId: s.waPhoneId,
        expiresAt: new Date(Date.now() + 29 * 86400000), uploadedBy: ctx.user._id });
    } catch { /* the template was still submitted; the file can be added to the library later */ }
  }
  const fields = Array.isArray(def.fields) ? def.fields.slice(0, 20).map((x) => String(x || '').slice(0, 60)) : [];
  const purpose = PURPOSES.includes(def.purpose) ? def.purpose : 'BULK';
  await M.Setting.updateOne({ key: 'system' }, { $set: { [`waTemplateMeta.${tpl.name}`]: { fields, purpose } } });
  await audit(ctx, { action: 'SUBMITTED_WHATSAPP_TEMPLATE', entityType: 'Setting', entityId: 'whatsapp', newData: { template: tpl.name, category: tpl.category, header: format, status: out.status } });
  return { ok: true, id: out.id, name: tpl.name, status: out.status, category: out.category, media: libraryItem?.toObject() || null };
}, { roles: ['ADMIN', 'COO'] });

// Delete a template at Meta (all its languages), e.g. a rejected one, so the name can be used again.
export const DELETE = handler(async (ctx) => {
  const name = new URL(ctx.req.url).searchParams.get('name') || '';
  if (!/^[a-z0-9_]{1,512}$/.test(name)) throw bad('Invalid template name');
  const s = await getSettings();
  if (!waConfigured(s)) throw bad('Connect WhatsApp first');
  const res = await fetch(`${process.env.WHATSAPP_GRAPH_URL || 'https://graph.facebook.com/v21.0'}/${s.waBusinessId}/message_templates?name=${name}`, {
    method: 'DELETE', headers: { authorization: `Bearer ${s.waToken}` }, signal: AbortSignal.timeout(20000),
  });
  const out = await res.json().catch(() => ({}));
  if (!res.ok || out.error) throw bad(out.error?.error_user_msg || out.error?.message || 'WhatsApp did not delete the template');
  await M.Setting.updateOne({ key: 'system' }, { $unset: { [`waTemplateMeta.${name}`]: '' } });
  await audit(ctx, { action: 'DELETED_WHATSAPP_TEMPLATE', entityType: 'Setting', entityId: 'whatsapp', oldData: { template: name } });
  return { ok: true };
}, { roles: ['ADMIN', 'COO'] });
