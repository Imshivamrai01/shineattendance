import { M } from '@/lib/db';
import { handler, readJson } from '@/lib/http';
import { createList } from '@/lib/crmLists';

// CRM lists of one kind (?kind=INTERVIEW | FEEDBACK), newest first, with how many people stand where.
export const GET = handler(async (ctx) => {
  const kind = new URL(ctx.req.url).searchParams.get('kind');
  const lists = await M.ContactList.find({ kind, archived: { $ne: true } }).sort({ createdAt: -1 }).limit(100).lean();
  return { lists: lists.map((l) => ({ ...l, contacts: undefined, count: l.contacts.length,
    counts: l.contacts.reduce((a, c) => ({ ...a, [c.status]: (a[c.status] || 0) + 1 }), {}) })) };
}, { roles: ['ADMIN', 'COO'] });

// { kind, title, date, time, venue, details, contacts: [{ name, phone }] }
export const POST = handler(async (ctx) => ({ list: (await createList(ctx, await readJson(ctx.req))).toObject() }), { roles: ['ADMIN', 'COO'] });
