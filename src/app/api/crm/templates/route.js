import { getSettings } from '@/lib/db';
import { handler, readJson, bad } from '@/lib/http';
import { audit } from '@/lib/audit';
import { createPreset, waConfigured } from '@/lib/whatsapp';

// Submit one of the ready-made templates to Meta for approval (usually approved within minutes to a day).
export const POST = handler(async (ctx) => {
  const { preset } = await readJson(ctx.req);
  const s = await getSettings();
  if (!waConfigured(s)) throw bad('Connect WhatsApp first');
  let out;
  try { out = await createPreset(s, preset); } catch (e) { throw bad(e.message); }
  await audit(ctx, { action: 'SUBMITTED_WHATSAPP_TEMPLATE', entityType: 'Setting', entityId: 'whatsapp', newData: { template: preset, status: out.status } });
  return { ok: true, status: out.status };
}, { roles: ['ADMIN', 'COO'] });
