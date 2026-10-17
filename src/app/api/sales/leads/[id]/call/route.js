import { M } from '@/lib/db';
import { readJson, bad, notFound, forbidden, oid } from '@/lib/http';
import { salesHandler, canSeeLead, applyCallOutcome, rescore, CALL_OUTCOMES, PENDING } from '@/lib/sales';
import { LEAD_STATUSES } from '@/models/Lead';

async function load(ctx) {
  const lead = await M.Lead.findById(oid(ctx.params.id, 'lead'));
  if (!lead || !(await canSeeLead(ctx, lead))) throw notFound('Lead not found');
  return lead;
}

/*
 * Pressing Call: the call is recorded straight away (who, when, which number) before the phone dials,
 * as PENDING until the caller says how it went with PATCH. Pressing Call twice within 2 minutes reuses the same entry.
 */
export const POST = salesHandler(async (ctx) => {
  const lead = await load(ctx);
  if (!lead.phone) throw bad('This lead has no phone number');
  const b = await readJson(ctx.req).catch(() => ({}));
  const phone = String(b.phone || lead.phone).slice(0, 30);
  const recent = await M.LeadActivity.findOne({ lead: lead._id, by: ctx.user._id, type: 'CALL', outcome: PENDING, createdAt: { $gt: new Date(Date.now() - 120000) } });
  if (recent) return { ok: true, activity: recent.toObject(), lead: lead.toObject() };
  const now = new Date();
  lead.callCount = (lead.callCount || 0) + 1;
  lead.lastCallAt = now; lead.lastCallBy = ctx.user._id; lead.lastOutcome = PENDING; lead.lastActivityAt = now;
  rescore(lead);
  await lead.save();
  const activity = await M.LeadActivity.create({ lead: lead._id, type: 'CALL', outcome: PENDING, viaApp: true, phone, by: ctx.user._id });
  return { ok: true, activity: activity.toObject(), lead: lead.toObject() };
});

// After the call: { activityId, outcome, note, followUpAt, status, durationSec }. Only the caller (or a sales manager) can fill it in, once.
export const PATCH = salesHandler(async (ctx) => {
  const lead = await load(ctx);
  const b = await readJson(ctx.req);
  const act = await M.LeadActivity.findOne({ _id: oid(b.activityId, 'call'), lead: lead._id, type: 'CALL' });
  if (!act) throw notFound('Call not found');
  if (String(act.by) !== String(ctx.user._id) && ctx.sales !== 'MANAGER') throw forbidden();
  if (act.outcome !== PENDING) throw bad('This call was already updated');
  if (!CALL_OUTCOMES[b.outcome]) throw bad('Choose how the call went');
  if (b.status && !LEAD_STATUSES.includes(b.status)) throw bad('Unknown status');
  const followUpAt = b.followUpAt ? new Date(b.followUpAt) : null;
  if (followUpAt && Number.isNaN(followUpAt.getTime())) throw bad('Invalid follow-up date');
  const note = String(b.note || '').trim().slice(0, 2000);
  const dur = Number(b.durationSec);

  act.note = note || undefined;
  act.endedAt = new Date();
  if (Number.isFinite(dur) && dur >= 0) act.durationSec = Math.min(Math.round(dur), 6 * 3600);
  applyCallOutcome(lead, act, { outcome: b.outcome, followUpAt, status: b.status || null });
  // An older pending call finished late must not overwrite the result of a newer call.
  const newer = await M.LeadActivity.exists({ lead: lead._id, type: 'CALL', createdAt: { $gt: act.createdAt } });
  if (newer) { lead.lastOutcome = (await M.LeadActivity.findOne({ lead: lead._id, type: 'CALL' }).sort({ createdAt: -1 }).lean())?.outcome; rescore(lead); }
  await lead.save();
  await act.save();
  return { ok: true, lead: lead.toObject(), activity: act.toObject() };
});
