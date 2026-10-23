import { handler, readJson } from '@/lib/http';
import { loadList, contactOf } from '@/lib/crmLists';
import { startOfficeCall } from '@/lib/staffCalls';

// IVR call to one person on the list: { contact }. Your phone rings first, then theirs (company number, recorded).
export const POST = handler(async (ctx) => {
  const list = await loadList(ctx);
  const c = contactOf(list, (await readJson(ctx.req)).contact);
  const call = await startOfficeCall(ctx, { section: list.kind, list: list._id, contact: c._id, name: c.name, phone: c.phone });
  return { ok: true, call: call.toObject() };
}, { roles: ['ADMIN', 'COO'] });
