import { M } from '@/lib/db';
import { readJson, notFound, oid } from '@/lib/http';
import { salesHandler, canSeeLead, logActivity } from '@/lib/sales';
import { startAiCall } from '@/lib/aiCalls';

// "AI call": the voice agent rings this lead now. { purpose } is passed to the agent as context.
export const POST = salesHandler(async (ctx) => {
  const lead = await M.Lead.findById(oid(ctx.params.id, 'lead'));
  if (!lead || !(await canSeeLead(ctx, lead))) throw notFound('Lead not found');
  const b = await readJson(ctx.req).catch(() => ({}));
  const call = await startAiCall(ctx, lead, { purpose: String(b.purpose || '').trim(), scriptId: b.scriptId });
  await logActivity(lead, ctx.user, { type: 'NOTE', note: `Started an AI call (${call.scriptName || 'Sales'}) to ${call.phone}${call.purpose ? `: ${call.purpose}` : ''}` });
  return { ok: true, call: call.toObject() };
});
