import { M, getSettings } from '@/lib/db';
import { handler, bad, notFound, oid } from '@/lib/http';
import { audit } from '@/lib/audit';
import { mediaKind, MEDIA_RULES, uploadMedia, waConfigured } from '@/lib/whatsapp';

// Media library for template headers: brochures (PDF), images and videos uploaded to WhatsApp (kept there for 30 days).
export const GET = handler(async () => {
  const s = await getSettings();
  const items = await M.WaMedia.find({ phoneId: s.waPhoneId, expiresAt: { $gt: new Date() } }).sort({ createdAt: -1 }).limit(100).populate('uploadedBy', 'name').lean();
  return { items, rules: Object.fromEntries(Object.entries(MEDIA_RULES).map(([k, v]) => [k, v.label])) };
}, { roles: ['ADMIN', 'COO'] });

export const POST = handler(async (ctx) => {
  const s = await getSettings();
  if (!waConfigured(s)) throw bad('Connect WhatsApp first');
  const form = await ctx.req.formData().catch(() => null);
  const f = form?.get('file');
  if (!f || typeof f === 'string' || !f.size) throw bad('Choose a file');
  const kind = mediaKind(f.type);
  if (!kind) throw bad('Use a PDF, a JPG / PNG image or an MP4 video');
  if (f.size > MEDIA_RULES[kind].max) throw bad(`File too big: ${MEDIA_RULES[kind].label}`);
  const name = String(f.name || 'file').slice(0, 200);
  let waMediaId;
  try { waMediaId = await uploadMedia(s, { bytes: new Uint8Array(await f.arrayBuffer()), mime: f.type, name }); } catch (e) { throw bad(`Upload to WhatsApp failed: ${e.message}`); }
  const item = await M.WaMedia.create({ kind, name, mime: f.type, size: f.size, waMediaId, phoneId: s.waPhoneId, expiresAt: new Date(Date.now() + 29 * 86400000), uploadedBy: ctx.user._id });
  await audit(ctx, { action: 'UPLOADED_WHATSAPP_MEDIA', entityType: 'WaMedia', entityId: item._id, newData: { kind, name, size: f.size } });
  return { ok: true, item: item.toObject() };
}, { roles: ['ADMIN', 'COO'] });

export const DELETE = handler(async (ctx) => {
  const id = oid(new URL(ctx.req.url).searchParams.get('id'), 'file');
  const item = await M.WaMedia.findByIdAndDelete(id);
  if (!item) throw notFound('File not found');
  await audit(ctx, { action: 'REMOVED_WHATSAPP_MEDIA', entityType: 'WaMedia', entityId: id, oldData: { name: item.name } });
  return { ok: true };
}, { roles: ['ADMIN', 'COO'] });
