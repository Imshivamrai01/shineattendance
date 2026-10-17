import { M } from '@/lib/db';
import { readJson, bad, notFound, oid } from '@/lib/http';
import { salesHandler, canSeeLead, rescore, logActivity, applyCallOutcome, CALL_OUTCOMES, CLOSED } from '@/lib/sales';
import { LEAD_STATUSES } from '@/models/Lead';

/*
 * Log a call made outside the Call button (another phone), a note or a planned follow-up.
 *  CALL: outcome required (see applyCallOutcome).  FOLLOW_UP: followUpAt required.  NOTE: note required.
 * Calls dialled from the app use ../call instead.
 */
export const POST = salesHandler(async (ctx) => {
  const lead = await M.Lead.findById(oid(ctx.params.id, 'lead'));
  if (!lead || !(await canSeeLead(ctx, lead))) throw notFound('Lead not found');
  const b = await readJson(ctx.req);
  const type = b.type;
  const note = String(b.note || '').trim().slice(0, 2000);
  const followUpAt = b.followUpAt ? new Date(b.followUpAt) : null;
  if (followUpAt && Number.isNaN(followUpAt.getTime())) throw bad('Invalid follow-up date');
  if (b.status && !LEAD_STATUSES.includes(b.status)) throw bad('Unknown status');
  const now = new Date();
  const act = { type, note: note || undefined };

  if (type === 'CALL') {
    if (!CALL_OUTCOMES[b.outcome]) throw bad('Choose how the call went');
    lead.callCount = (lead.callCount || 0) + 1;
    lead.lastCallAt = now; lead.lastCallBy = ctx.user._id;
    applyCallOutcome(lead, act, { outcome: b.outcome, followUpAt, status: b.status || null });
  } else if (type === 'FOLLOW_UP' || type === 'NOTE') {
    if (type === 'FOLLOW_UP' && !followUpAt) throw bad('Pick the follow-up date and time');
    if (type === 'NOTE' && !note) throw bad('Write the note');
    let status = b.status || null;
    if (!status && type === 'FOLLOW_UP' && ['NEW', 'CONTACTED'].includes(lead.status)) status = 'FOLLOW_UP';
    if (status && status !== lead.status) { act.from = lead.status; act.to = status; lead.status = status; }
    if (followUpAt && !CLOSED.includes(lead.status)) { lead.nextFollowUpAt = followUpAt; act.followUpAt = followUpAt; }
    if (CLOSED.includes(lead.status)) lead.nextFollowUpAt = undefined;
    lead.lastActivityAt = now;
    rescore(lead);
  } else throw bad('Unknown activity');

  await lead.save();
  await logActivity(lead, ctx.user, act);
  return { ok: true, lead: lead.toObject() };
});
