import { handler, readJson, bad } from '@/lib/http';
import { queueContacts } from '@/lib/aiCalls';
import { loadList, listPurpose } from '@/lib/crmLists';

// AI calls to people on the list: { contacts: [ids], purpose?, scriptId? }. They go on the AI call list, one at a time.
// The agent is told the role, date, time and venue (or what the feedback is about) and talks about that only.
export const POST = handler(async (ctx) => {
  const list = await loadList(ctx);
  const b = await readJson(ctx.req);
  const ids = new Set((b.contacts || []).map(String));
  const picked = list.contacts.filter((c) => ids.has(String(c._id)));
  if (!picked.length) throw bad('Choose at least one person');
  const purpose = listPurpose(list, String(b.purpose || '').trim());
  const { queued, skipped } = await queueContacts(ctx, picked.map((c) => ({ name: c.name, phone: c.phone, list: list._id, contact: c._id })),
    { purpose, scriptId: b.scriptId, kind: list.kind });
  return { queued, skipped, purpose };
}, { roles: ['ADMIN', 'COO'] });
