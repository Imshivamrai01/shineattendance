import { M } from '@/lib/db';
import { readJson, bad, notFound, oid } from '@/lib/http';
import { salesHandler, canSeeLead, rescore, logActivity, phoneKey, cleanInstagram, salesRole, CLOSED } from '@/lib/sales';
import { LEAD_STATUSES } from '@/models/Lead';

async function load(ctx) {
  const lead = await M.Lead.findById(oid(ctx.params.id, 'lead'));
  if (!lead || !(await canSeeLead(ctx, lead))) throw notFound('Lead not found');
  return lead;
}

export const GET = salesHandler(async (ctx) => {
  const lead = await load(ctx);
  await lead.populate([{ path: 'assignedTo', select: 'name' }, { path: 'lastCallBy', select: 'name' }, { path: 'createdBy', select: 'name' },
    { path: 'scrapes', select: 'location category source createdAt' }]);
  const activity = await M.LeadActivity.find({ lead: lead._id }).sort({ createdAt: -1 }).limit(200).populate('by', 'name').lean();
  // Names for ASSIGN / CREATED entries (from / to hold user ids)
  const ids = [...new Set(activity.flatMap((a) => [a.from, a.to]).filter((x) => /^[a-f\d]{24}$/i.test(x || '')))];
  const names = Object.fromEntries((await M.User.find({ _id: { $in: ids } }).select('name').lean()).map((u) => [String(u._id), u.name]));
  return { lead: lead.toObject(), activity, names };
});

const TEXT = { name: 200, phone: 30, address: 300, area: 100, city: 100, category: 80, website: 300, email: 120, notes: 2000 };

// Edit details, change status / owner / next follow-up. Every change lands on the lead's timeline.
export const PATCH = salesHandler(async (ctx) => {
  const lead = await load(ctx);
  const b = await readJson(ctx.req);
  const edited = [], acts = [];
  for (const [k, max] of Object.entries(TEXT)) {
    if (b[k] === undefined) continue;
    const v = String(b[k] ?? '').trim().slice(0, max);
    if (k === 'name' && v.length < 2) throw bad('Business name is required');
    if (v !== (lead[k] || '')) { lead[k] = v; edited.push(k); }
  }
  if (b.instagram !== undefined) {
    const v = cleanInstagram(b.instagram);
    if (b.instagram && !v) throw bad('Instagram: paste the profile link or @username');
    if (v !== (lead.instagram || '')) { lead.instagram = v; edited.push('instagram'); }
  }
  if (edited.includes('phone')) {
    lead.phoneKey = phoneKey(lead.phone);
    if (lead.phoneKey) {
      const dup = await M.Lead.findOne({ _id: { $ne: lead._id }, phoneKey: lead.phoneKey }).select('name').lean();
      if (dup) throw bad(`Another lead already has this number: ${dup.name}`);
    }
  }
  if (edited.length) acts.push({ type: 'EDIT', note: `Changed ${edited.join(', ')}` });

  if (b.status !== undefined && b.status !== lead.status) {
    if (!LEAD_STATUSES.includes(b.status)) throw bad('Unknown status');
    acts.push({ type: 'STATUS', from: lead.status, to: b.status, note: b.note ? String(b.note).slice(0, 2000) : undefined });
    lead.status = b.status;
    if (CLOSED.includes(b.status)) lead.nextFollowUpAt = undefined;
  }
  if (b.nextFollowUpAt !== undefined) {
    const d = b.nextFollowUpAt ? new Date(b.nextFollowUpAt) : null;
    if (d && Number.isNaN(d.getTime())) throw bad('Invalid follow-up date');
    lead.nextFollowUpAt = d || undefined;
    acts.push({ type: 'FOLLOW_UP', followUpAt: d || undefined, note: d ? undefined : 'Follow-up cleared' });
  }
  if (b.assignedTo !== undefined && String(b.assignedTo || '') !== String(lead.assignedTo || '')) {
    if (ctx.sales !== 'MANAGER') throw bad('Only a sales manager can change who handles a lead');
    if (b.assignedTo) {
      const u = await M.User.findById(oid(b.assignedTo, 'user')).lean();
      if (!u || u.status !== 'ACTIVE' || !salesRole(u)) throw bad('That person has no sales access');
    }
    acts.push({ type: 'ASSIGN', from: lead.assignedTo ? String(lead.assignedTo) : '', to: b.assignedTo ? String(b.assignedTo) : '' });
    lead.assignedTo = b.assignedTo || undefined;
  }
  if (!acts.length) return { ok: true, lead: lead.toObject() };
  lead.lastActivityAt = new Date();
  rescore(lead);
  await lead.save();
  for (const a of acts) await logActivity(lead, ctx.user, a);
  return { ok: true, lead: lead.toObject() };
});
