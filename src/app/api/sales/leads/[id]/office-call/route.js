import { M } from '@/lib/db';
import { notFound, oid } from '@/lib/http';
import { salesHandler, canSeeLead } from '@/lib/sales';
import { startOfficeCall } from '@/lib/officeCalls';

// Call through the office line: the caller's phone rings first, then the lead (company number shown, call recorded).
export const POST = salesHandler(async (ctx) => {
  const lead = await M.Lead.findById(oid(ctx.params.id, 'lead'));
  if (!lead || !(await canSeeLead(ctx, lead))) throw notFound('Lead not found');
  const activity = await startOfficeCall(ctx, lead);
  return { ok: true, activity: activity.toObject(), lead: lead.toObject() };
});
