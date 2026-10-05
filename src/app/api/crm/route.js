import { M, getSettings } from '@/lib/db';
import { handler } from '@/lib/http';
import { accountInfo, listTemplates, waConfigured, PRESETS } from '@/lib/whatsapp';


// Everything the CRM page needs: connection status, templates, employees to pick from, and recent sends.
export const GET = handler(async () => {
  const s = await getSettings();
  const out = { configured: waConfigured(s), phoneId: s.waPhoneId || '', businessId: s.waBusinessId || '', hasToken: !!s.waToken, templates: [] };
  if (out.configured) {
    try {
      [out.account, out.templates] = await Promise.all([accountInfo(s), listTemplates(s)]);
    } catch (e) { out.error = e.message; }
  }
  out.presets = Object.entries(PRESETS).map(([name, p]) => ({ name, label: p.label, purpose: p.purpose, text: p.text, fields: p.fields,
    status: out.templates.find((t) => t.name === name)?.status || null }));
  out.employees = await M.User.find({ status: 'ACTIVE', role: { $ne: 'ADMIN' } }).select('name employeeId role mobile designation').sort({ name: 1 }).lean();
  out.history = await M.WaMessage.find().sort({ createdAt: -1 }).limit(100).select('to name template status error purpose createdAt').lean();
  return out;
}, { roles: ['ADMIN', 'COO'] });
