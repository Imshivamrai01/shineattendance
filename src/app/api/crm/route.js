import { M, getSettings } from '@/lib/db';
import { handler } from '@/lib/http';
import { accountInfo, listTemplates, waConfigured, webhookInfo, PRESETS } from '@/lib/whatsapp';


// Everything the CRM page needs: connection status, templates, employees to pick from, and recent sends.
export const GET = handler(async (ctx) => {
  const s = await getSettings();
  const out = { configured: waConfigured(s), phoneId: s.waPhoneId || '', businessId: s.waBusinessId || '', hasToken: !!s.waToken, templates: [] };
  out.webhook = await webhookInfo(s, M, process.env.APP_URL?.replace(/\/$/, '') || new URL(ctx.req.url).origin);
  if (out.configured) {
    // Checked separately so the page can say which of the two IDs is wrong.
    const [acc, tpl] = await Promise.allSettled([accountInfo(s), listTemplates(s)]);
    if (acc.status === 'fulfilled') out.account = acc.value;
    if (tpl.status === 'fulfilled') out.templates = tpl.value;
    const bad100 = (r) => r.status === 'rejected' && r.reason?.wa?.code === 100;
    if (bad100(acc)) out.error = `Phone number ID ${s.waPhoneId} is wrong for this token. Open WhatsApp settings and copy the Phone number ID shown under the number in WhatsApp → API Setup.`;
    else if (bad100(tpl)) out.error = `WhatsApp Business Account ID ${s.waBusinessId} is wrong for this token. Open WhatsApp settings and use the "Messaging Account ID" shown above the number in WhatsApp → Production setup (not the App ID or the Business portfolio ID).`;
    else out.error = [acc, tpl].find((r) => r.status === 'rejected')?.reason?.message;
  }
  out.presets = Object.entries(PRESETS).map(([name, p]) => ({ name, label: p.label, purpose: p.purpose, text: p.text, fields: p.fields,
    status: out.templates.find((t) => t.name === name)?.status || null }));
  out.employees = await M.User.find({ status: 'ACTIVE', role: { $ne: 'ADMIN' } }).select('name employeeId role mobile designation').sort({ name: 1 }).lean();
  out.history = await M.WaMessage.find().sort({ createdAt: -1 }).limit(100).select('to name template status error purpose direction text deliveredAt readAt createdAt').lean();
  return out;
}, { roles: ['ADMIN', 'COO'] });
