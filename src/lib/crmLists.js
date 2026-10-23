import mongoose from 'mongoose';
import { M } from './db.js';
import { bad, notFound } from './http.js';
import { LIST_KINDS } from '../models/ContactList.js';

/*
 * CRM lists: one per interview role ("Sales Executive, 28 Oct, 11 am") or per customer group to ask for feedback.
 * People are added as name + number (typed, pasted or several at once) and then called (IVR / AI) or messaged.
 */

const MAX_CONTACTS = 500;
const clip = (v, n) => String(v ?? '').trim().slice(0, n);

/** [{ name, phone }] from the page, cleaned: empty rows dropped, numbers already on the list skipped. */
export function cleanContacts(rows, existing = []) {
  const key = (p) => String(p || '').replace(/\D/g, '').slice(-10);
  const seen = new Set(existing.map((c) => key(c.phone)));
  const out = [];
  for (const r of Array.isArray(rows) ? rows : []) {
    const name = clip(r?.name, 120), phone = clip(r?.phone, 30);
    if (!phone || key(phone).length < 10 || seen.has(key(phone))) continue;
    seen.add(key(phone));
    out.push({ name, phone });
  }
  return out;
}

export function listFields(b) {
  const f = {};
  for (const [k, n] of [['title', 120], ['date', 60], ['time', 40], ['venue', 200], ['details', 500]]) if (b[k] != null) f[k] = clip(b[k], n);
  return f;
}

export async function createList(ctx, b) {
  if (!LIST_KINDS.includes(b.kind)) throw bad('Unknown list type');
  const f = listFields(b);
  if (!f.title) throw bad(b.kind === 'INTERVIEW' ? 'Enter the role, e.g. Sales Executive' : 'Give the list a name');
  const contacts = cleanContacts(b.contacts).slice(0, MAX_CONTACTS);
  return M.ContactList.create({ kind: b.kind, ...f, contacts, createdBy: ctx.user._id });
}

export async function loadList(ctx) {
  if (!mongoose.isValidObjectId(ctx.params.id)) throw bad('Invalid list');
  const list = await M.ContactList.findById(ctx.params.id);
  if (!list) throw notFound('List not found');
  return list;
}

/** What the AI agent is told the call is about (it talks about this only). */
export function listPurpose(list, extra = '') {
  const base = list.kind === 'INTERVIEW'
    ? `Interview invite for the ${list.title} role${list.date ? ` on ${list.date}` : ''}${list.time ? ` at ${list.time}` : ''}${list.venue ? `, venue: ${list.venue}` : ''}`
    : `Feedback about ${list.title}`;
  return [base, list.details, extra].map((x) => clip(x, 300)).filter(Boolean).join('. ').slice(0, 300);
}

export const contactOf = (list, id) => {
  const c = list.contacts.id(id);
  if (!c) throw notFound('Person not found on this list');
  return c;
};
