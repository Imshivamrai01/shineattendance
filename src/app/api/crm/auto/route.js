import { M, getSettings } from '@/lib/db';
import { handler, readJson, bad, oid } from '@/lib/http';
import { audit } from '@/lib/audit';
import { autoConfig } from '@/lib/waAuto';

// WhatsApp sent on their own: brochure after an interested sales call, task assigned, no attendance yet.
export const GET = handler(async () => ({ auto: autoConfig(await getSettings()) }), { roles: ['ADMIN', 'COO'] });

const tpl = (v) => (/^[a-z0-9_]{1,512}$/.test(v || '') ? v : undefined);
const lang = (v) => (/^[a-zA-Z_]{2,8}$/.test(v || '') ? v : undefined);

// { brochure: { on, template, language, mediaId, services }, task: { on, template, language }, absent: { on, template, language, afterMin } } (any part)
export const PUT = handler(async (ctx) => {
  const b = await readJson(ctx.req);
  const cur = autoConfig(await getSettings());
  const next = { ...cur };
  for (const k of ['brochure', 'task', 'absent']) {
    const x = b[k];
    if (!x) continue;
    const n = { ...cur[k] };
    if (typeof x.on === 'boolean') n.on = x.on;
    if (tpl(x.template)) n.template = x.template;
    if (lang(x.language)) n.language = x.language;
    if (k === 'brochure' && x.mediaId !== undefined) n.mediaId = x.mediaId ? oid(x.mediaId, 'file') : '';
    if (k === 'brochure' && x.services != null) n.services = String(x.services).trim().slice(0, 200) || cur.brochure.services;
    if (k === 'absent' && x.afterMin != null) {
      const m = Number(x.afterMin);
      if (!Number.isFinite(m) || m < 0 || m > 600) throw bad('Minutes after office start: 0 to 600');
      n.afterMin = Math.round(m);
    }
    if (k === 'brochure' && n.on && !n.mediaId) throw bad('Choose the brochure PDF first');
    next[k] = n;
  }
  await M.Setting.updateOne({ key: 'system' }, { $set: { waAuto: next } });
  await audit(ctx, { action: 'CHANGED_WHATSAPP_AUTOMATION', entityType: 'Setting', entityId: 'waAuto', oldData: cur, newData: next });
  return { auto: next };
}, { roles: ['ADMIN', 'COO'] });
