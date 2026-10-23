import { handler, readJson, bad } from '@/lib/http';
import { CONTACT_STATUSES } from '@/models/ContactList';
import { loadList, listFields, cleanContacts, contactOf } from '@/lib/crmLists';

const ROLES = { roles: ['ADMIN', 'COO'] };

export const GET = handler(async (ctx) => ({ list: (await loadList(ctx)).toObject() }), ROLES);

/*
 * Change a list: { title, date, time, venue, details } and/or { add: [{ name, phone }] } and/or
 * { contact: id, status?, note?, name?, phone? } and/or { remove: contact id } and/or { archived: true }.
 */
export const PATCH = handler(async (ctx) => {
  const list = await loadList(ctx);
  const b = await readJson(ctx.req);
  Object.assign(list, listFields(b));
  if (!list.title) throw bad('The list needs a name');
  let added = 0;
  if (Array.isArray(b.add)) {
    const fresh = cleanContacts(b.add, list.contacts).slice(0, Math.max(0, 500 - list.contacts.length));
    list.contacts.push(...fresh);
    added = fresh.length;
  }
  if (b.contact) {
    const c = contactOf(list, b.contact);
    if (b.status) { if (!CONTACT_STATUSES.includes(b.status)) throw bad('Unknown status'); c.status = b.status; }
    if (b.note != null) c.note = String(b.note).trim().slice(0, 1000);
    if (b.name != null) c.name = String(b.name).trim().slice(0, 120);
    if (b.phone != null) c.phone = String(b.phone).trim().slice(0, 30);
  }
  if (b.remove) contactOf(list, b.remove).deleteOne();
  if (b.archived === true) list.archived = true;
  await list.save();
  return { list: list.toObject(), added };
}, ROLES);
