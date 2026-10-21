import { readJson } from '@/lib/http';
import { salesHandler } from '@/lib/sales';
import { queueAiCalls, cancelQueued, queueStatus } from '@/lib/aiCalls';

// The AI call list: who is being called now, who is next.
export const GET = salesHandler(async (ctx) => queueStatus(ctx));

// { leadIds: [...], purpose, scriptId } — put leads on the list; the agent calls them one after another during calling hours.
export const POST = salesHandler(async (ctx) => {
  const b = await readJson(ctx.req);
  return queueAiCalls(ctx, Array.isArray(b.leadIds) ? b.leadIds : [], { purpose: String(b.purpose || '').trim(), scriptId: b.scriptId });
});

// Stop: take every waiting call off the list (a call already ringing finishes normally).
export const DELETE = salesHandler(async (ctx) => cancelQueued(ctx));
