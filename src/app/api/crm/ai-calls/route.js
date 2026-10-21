import { M } from '@/lib/db';
import { handler, readJson } from '@/lib/http';
import { queueContacts, queueStatus, aiConfigured } from '@/lib/aiCalls';

// CRM page, "AI calls": calls to people who are not sales leads (interview invites, feedback). Admin / COO only, like the rest of the CRM page.
const crm = (fn) => handler(async (ctx) => fn({ ...ctx, sales: 'MANAGER' }), { roles: ['ADMIN', 'COO'] });

export const GET = crm(async (ctx) => {
  const [calls, queue] = await Promise.all([
    M.AiCall.find({ lead: null, status: { $nin: ['SCHEDULED', 'CANCELLED'] } }).select('-transcript').sort({ createdAt: -1 }).limit(100).lean(),
    queueStatus(ctx),
  ]);
  return { calls, queue, connected: aiConfigured() };
});

// { contacts: [{ name, phone }], scriptId, details } — the agent calls them one after another during calling hours.
export const POST = crm(async (ctx) => {
  const b = await readJson(ctx.req);
  const contacts = (Array.isArray(b.contacts) ? b.contacts : []).map((c) => ({ name: String(c?.name || ''), phone: String(c?.phone || '') }));
  return queueContacts(ctx, contacts, { scriptId: b.scriptId, purpose: String(b.details || '').trim() });
});
