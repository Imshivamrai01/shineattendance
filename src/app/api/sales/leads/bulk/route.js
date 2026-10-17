import { M } from '@/lib/db';
import { readJson, bad } from '@/lib/http';
import { salesHandler, salesRole, rescore, CLOSED } from '@/lib/sales';
import { LEAD_STATUSES } from '@/models/Lead';

// Sales managers: assign many leads to someone (or nobody) and / or set their status in one go.
export const POST = salesHandler(async (ctx) => {
  const b = await readJson(ctx.req);
  const ids = Array.isArray(b.ids) ? b.ids.filter((x) => /^[a-f\d]{24}$/i.test(x)).slice(0, 500) : [];
  if (!ids.length) throw bad('Select some leads');
  const doAssign = b.assignedTo !== undefined, doStatus = !!b.status;
  if (!doAssign && !doStatus) throw bad('Nothing to change');
  if (doStatus && !LEAD_STATUSES.includes(b.status)) throw bad('Unknown status');
  if (doAssign && b.assignedTo) {
    const u = await M.User.findById(b.assignedTo).lean();
    if (!u || u.status !== 'ACTIVE' || !salesRole(u)) throw bad('That person has no sales access');
  }
  const leads = await M.Lead.find({ _id: { $in: ids } });
  const acts = []; const now = new Date();
  for (const l of leads) {
    if (doAssign && String(l.assignedTo || '') !== String(b.assignedTo || '')) {
      acts.push({ lead: l._id, type: 'ASSIGN', from: l.assignedTo ? String(l.assignedTo) : '', to: b.assignedTo ? String(b.assignedTo) : '', by: ctx.user._id });
      l.assignedTo = b.assignedTo || undefined;
    }
    if (doStatus && l.status !== b.status) {
      acts.push({ lead: l._id, type: 'STATUS', from: l.status, to: b.status, by: ctx.user._id });
      l.status = b.status;
      if (CLOSED.includes(b.status)) l.nextFollowUpAt = undefined;
    }
    rescore(l);
    l.lastActivityAt = now;
  }
  await M.Lead.bulkSave(leads);
  if (acts.length) await M.LeadActivity.insertMany(acts);
  return { ok: true, changed: acts.length };
}, { manager: true });
