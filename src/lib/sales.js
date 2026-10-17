import { M } from './db.js';
import { handler, forbidden } from './http.js';
import { cleanInstagram } from './leadFinder.js';

export const CALL_OUTCOMES = {
  CONNECTED: 'Talked', CALL_BACK: 'Asked to call back', NO_ANSWER: 'No answer', CALL_CUT: 'Call cut', BUSY: 'Busy',
  SWITCHED_OFF: 'Switched off', WRONG_NUMBER: 'Wrong number',
};
// A call started from the Call button, still waiting for the caller to say how it went.
export const PENDING = 'PENDING';

/** 'MANAGER' (sees and assigns every lead), 'AGENT' (only leads assigned to them) or null. */
export function salesRole(user) {
  if (!user) return null;
  if (user.role === 'ADMIN' || user.role === 'COO') return 'MANAGER';
  return ['AGENT', 'MANAGER'].includes(user.salesAccess) ? user.salesAccess : null;
}

/** Route wrapper for the Sales pages: signed in + sales access (`manager`: sales managers only). ctx.sales is the role. */
export function salesHandler(fn, { manager = false } = {}) {
  return handler(async (ctx) => {
    const r = salesRole(ctx.user);
    if (!r || (manager && r !== 'MANAGER')) throw forbidden();
    ctx.sales = r;
    return fn(ctx);
  });
}

/** Mongo filter for the leads this user may see. */
export const leadScope = (ctx) => (ctx.sales === 'MANAGER' ? {} : { assignedTo: ctx.user._id });

export async function canSeeLead(ctx, lead) {
  return ctx.sales === 'MANAGER' || String(lead.assignedTo || '') === String(ctx.user._id);
}

// ---- Dedupe keys ----

/** Digits only; Indian numbers (+91 / 0 prefix) become their 10 digits so every way of writing them matches. */
export function phoneKey(raw) {
  let d = String(raw || '').replace(/\D/g, '');
  if (d.length === 12 && d.startsWith('91')) d = d.slice(2);
  else if (d.length === 11 && d.startsWith('0')) d = d.slice(1);
  else if (d.length === 13 && d.startsWith('091')) d = d.slice(3);
  return d.length >= 8 ? d : '';
}
export const isMobile = (key) => /^[6-9]\d{9}$/.test(key || '');

/** Business name without punctuation / common filler words, plus position rounded to ~200 m (or city when unknown). */
export function nameKey(name, { lat, lng, city } = {}) {
  const n = String(name || '').toLowerCase().normalize('NFKD').replace(/[^a-z0-9ऀ-ॿ]+/g, ' ')
    .replace(/\b(the|pvt|private|ltd|limited|and|&)\b/g, ' ').replace(/\s+/g, '');
  if (!n) return '';
  const where = Number.isFinite(lat) && Number.isFinite(lng) ? `${lat.toFixed(3)},${lng.toFixed(3)}` : String(city || '').toLowerCase().replace(/\s+/g, '');
  return `${n}@${where}`;
}

export { cleanInstagram };

// ---- Lead quality ----

/**
 * Score 0-100 from how reachable / established the business looks, then adjusted by what the calls found.
 * HOT >= 60, WARM >= 35, else COLD. `notes` explains the score in plain words.
 */
export function scoreLead(l) {
  let s = 0; const notes = [];
  const add = (n, why) => { s += n; if (why) notes.push(`${n > 0 ? '+' : ''}${n} ${why}`); };
  const key = l.phoneKey || phoneKey(l.phone);
  if (key) add(isMobile(key) ? 25 : 18, isMobile(key) ? 'mobile number' : 'landline number');
  else notes.push('no phone number');
  if (l.instagram) add(10, 'on Instagram');
  if (l.website) add(8, 'has a website');
  if (l.email) add(4, 'has an email');
  if (l.address) add(3, 'full address');
  if (l.rating >= 4) add(5, `rated ${l.rating}`);
  else if (l.rating && l.rating < 3) add(-5, `low rating ${l.rating}`);
  if (l.reviews >= 200) add(10, `${l.reviews} reviews`);
  else if (l.reviews >= 50) add(6, `${l.reviews} reviews`);
  else if (l.reviews >= 10) add(3, `${l.reviews} reviews`);
  if (l.timesFound > 1) add(3, `found ${l.timesFound} times`);
  if (l.connectedCount) add(Math.min(9, 3 * l.connectedCount), `${l.connectedCount} connected call${l.connectedCount > 1 ? 's' : ''}`);
  if (l.callCount >= 3 && !l.connectedCount) add(-10, `${l.callCount} calls, never reached`);
  const st = { CONTACTED: [5, 'contacted'], FOLLOW_UP: [15, 'follow-up planned'], INTERESTED: [25, 'interested'] }[l.status];
  if (st) add(...st);
  s = Math.max(0, Math.min(100, s));
  if (l.status === 'CONVERTED') { s = 100; notes.push('converted'); }
  if (l.status === 'NOT_INTERESTED') { s = Math.min(s, 15); notes.push('not interested'); }
  if (l.status === 'INVALID' || l.lastOutcome === 'WRONG_NUMBER') { s = 0; notes.push(l.status === 'INVALID' ? 'marked invalid' : 'wrong number'); }
  return { score: s, grade: s >= 60 ? 'HOT' : s >= 35 ? 'WARM' : 'COLD', scoreNotes: notes };
}

/** Recompute and store the score on a lead document (call before save). */
export function rescore(doc) {
  Object.assign(doc, scoreLead(doc));
  return doc;
}

export const logActivity = (lead, user, data) => M.LeadActivity.create({ lead: lead._id || lead, by: user?._id, ...data });

/** Sales people the leads can be assigned to. */
export async function salesTeam() {
  const users = await M.User.find({ status: 'ACTIVE', $or: [{ role: { $in: ['ADMIN', 'COO'] } }, { salesAccess: { $in: ['AGENT', 'MANAGER'] } }] })
    .select('name role salesAccess employeeId mobile').sort({ name: 1 }).lean();
  return users.map((u) => ({ _id: u._id, name: u.name, role: u.role, employeeId: u.employeeId, sales: salesRole(u) }));
}

/** Filters shared by the leads list and the CSV export (query string -> Mongo filter). */
export function leadFilter(ctx, q) {
  const f = { ...leadScope(ctx) };
  const v = (k) => (q.get(k) || '').trim();
  if (v('status')) f.status = v('status');
  else if (v('open') === '1') f.status = { $nin: ['CONVERTED', 'NOT_INTERESTED', 'INVALID'] };
  if (v('grade')) f.grade = v('grade');
  if (v('category')) f.category = v('category');
  if (v('source')) f.source = v('source');
  if (v('bucket') === 'repeat') f.timesFound = { $gt: 1 };
  if (v('bucket') === 'fresh') f.timesFound = { $lte: 1 };
  if (v('called') === '1') f.callCount = { $gt: 0 };
  if (v('called') === '0') f.callCount = 0;
  if (ctx.sales === 'MANAGER' && v('assigned')) f.assignedTo = v('assigned') === 'none' ? null : v('assigned');
  if (v('due') === 'today') f.nextFollowUpAt = { $lte: endOfTodayIst() };
  if (v('scrape')) f.scrapes = v('scrape');
  if (v('q')) {
    const rx = new RegExp(v('q').replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
    const digits = v('q').replace(/\D/g, '');
    f.$or = [{ name: rx }, { address: rx }, { city: rx }, { category: rx }, { instagram: rx }, ...(digits.length >= 4 ? [{ phoneKey: new RegExp(digits) }] : [])];
  }
  return f;
}

/** End of the current day in India (follow-ups due "today" includes overdue ones). */
export function endOfTodayIst(now = new Date()) {
  const ist = new Date(now.getTime() + 330 * 60000);
  ist.setUTCHours(23, 59, 59, 999);
  return new Date(ist.getTime() - 330 * 60000);
}
export function startOfTodayIst(now = new Date()) {
  const ist = new Date(now.getTime() + 330 * 60000);
  ist.setUTCHours(0, 0, 0, 0);
  return new Date(ist.getTime() - 330 * 60000);
}

const FILLABLE = ['phone', 'address', 'area', 'city', 'instagram', 'website', 'email', 'mapsUrl', 'lat', 'lng', 'sourceId'];
const blank = (v) => v == null || v === '' || (typeof v === 'number' && !Number.isFinite(v));

/**
 * Saves found / typed-in businesses without ever storing one twice. A business matches an existing lead by
 * phone number, by Google / OSM id, or by name at the same spot. Matches are "found again": timesFound goes up,
 * empty fields are filled in, and the lead shows under Repeat leads. Returns { fresh, repeat } lead documents.
 */
export async function mergeLeads(ctx, items, { category = '', searchLocation = '', job, assignTo = null, source = 'MANUAL' } = {}) {
  const now = new Date();
  const seen = new Set(); const list = [];
  for (const it of items) {
    const pk = phoneKey(it.phone); const nk = nameKey(it.name, it); const ig = cleanInstagram(it.instagram);
    const keys = [pk && `p:${pk}`, it.sourceId && `s:${it.sourceId}`, nk && `n:${nk}`, ig && `i:${ig}`].filter(Boolean);
    if (keys.some((k) => seen.has(k))) continue; // the same business twice in one search
    keys.forEach((k) => seen.add(k));
    list.push({ ...it, instagram: ig, phoneKey: pk, nameKey: nk });
  }
  const or = [];
  const all = (k) => list.map((l) => l[k]).filter(Boolean);
  for (const k of ['phoneKey', 'sourceId', 'nameKey', 'instagram']) if (all(k).length) or.push({ [k]: { $in: all(k) } });
  const existing = or.length ? await M.Lead.find({ $or: or }) : [];
  const match = (l) => existing.find((e) => ['phoneKey', 'sourceId', 'nameKey', 'instagram'].some((k) => l[k] && e[k] === l[k]));

  const fresh = [], repeat = [], touched = new Set(), acts = [];
  const where = [category, searchLocation].filter(Boolean).join(' in ');
  for (const l of list) {
    const e = match(l);
    if (e) {
      if (touched.has(String(e._id))) continue;
      touched.add(String(e._id));
      e.timesFound = (e.timesFound || 1) + 1; e.lastFoundAt = now;
      if (job) e.scrapes = [...(e.scrapes || []), job].slice(-20);
      for (const k of FILLABLE) if (blank(e[k]) && !blank(l[k])) e[k] = l[k];
      if (!e.phoneKey && e.phone) e.phoneKey = phoneKey(e.phone);
      if (l.rating) { e.rating = l.rating; e.reviews = l.reviews; }
      rescore(e);
      await e.save();
      acts.push({ lead: e._id, type: 'FOUND_AGAIN', note: where ? `Found again: ${where}` : 'Added again by hand', by: ctx.user._id });
      repeat.push(e);
    } else {
      const doc = new (M.Lead)({
        name: String(l.name).trim().slice(0, 200), phone: l.phone || '', phoneKey: l.phoneKey, altPhones: l.altPhones || [],
        address: l.address, area: l.area, city: l.city, category: l.category || category, searchLocation: l.searchLocation || searchLocation,
        instagram: l.instagram, website: l.website, email: l.email, mapsUrl: l.mapsUrl, rating: l.rating, reviews: l.reviews, lat: l.lat, lng: l.lng,
        source: l.source || source, sourceId: l.sourceId || undefined, nameKey: l.nameKey, notes: l.notes,
        assignedTo: assignTo || undefined, createdBy: ctx.user._id, timesFound: 1, firstFoundAt: now, lastFoundAt: now,
        scrapes: job ? [job] : [], lastActivityAt: now,
      });
      rescore(doc);
      fresh.push(doc);
    }
  }
  if (fresh.length) {
    await M.Lead.insertMany(fresh);
    acts.push(...fresh.map((d) => ({ lead: d._id, type: 'CREATED', note: where ? `Found: ${where}` : 'Added by hand', by: ctx.user._id, to: assignTo ? String(assignTo) : undefined })));
  }
  if (acts.length) await M.LeadActivity.insertMany(acts);
  return { fresh, repeat };
}

export const CLOSED = ['CONVERTED', 'NOT_INTERESTED', 'INVALID'];

/**
 * How a finished call changes its lead (mutates both). `act` is the CALL activity being written / completed.
 * A call finishes any follow-up that was due; `followUpAt` sets the next one. Without an explicit status:
 * wrong number -> INVALID, a follow-up date -> FOLLOW_UP, a first call NEW -> CONTACTED.
 */
export function applyCallOutcome(lead, act, { outcome, followUpAt, status }) {
  act.outcome = outcome;
  if (outcome === 'CONNECTED') lead.connectedCount = (lead.connectedCount || 0) + 1;
  lead.lastOutcome = outcome;
  lead.nextFollowUpAt = undefined;
  if (!status) {
    if (outcome === 'WRONG_NUMBER') status = 'INVALID';
    else if (followUpAt && ['NEW', 'CONTACTED'].includes(lead.status)) status = 'FOLLOW_UP';
    else if (lead.status === 'NEW') status = 'CONTACTED';
  }
  if (status && status !== lead.status) { act.from = lead.status; act.to = status; lead.status = status; }
  if (followUpAt && !CLOSED.includes(lead.status)) { lead.nextFollowUpAt = followUpAt; act.followUpAt = followUpAt; }
  lead.lastActivityAt = new Date();
  rescore(lead);
}
