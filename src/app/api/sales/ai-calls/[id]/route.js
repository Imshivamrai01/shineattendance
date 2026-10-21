import { readJson } from '@/lib/http';
import { salesHandler, logActivity } from '@/lib/sales';
import { queueAiCallSync, loadAiCall } from '@/lib/aiCalls';

// One AI call with its transcript.
export const GET = salesHandler(async (ctx) => {
  const call = await loadAiCall(ctx);
  await call.populate([{ path: 'lead', select: 'name phone status assignedTo nextFollowUpAt' }, { path: 'requestedBy', select: 'name' }, { path: 'handledBy', select: 'name' }]);
  const out = call.toObject();
  delete out.recordingUrl; // the browser plays it through /recording, never from the carrier directly
  out.hasRecording = !!call.recordingId;
  return { call: out };
});

// { handled: true } — someone on the team took the callback.
export const PATCH = salesHandler(async (ctx) => {
  const call = await loadAiCall(ctx);
  const b = await readJson(ctx.req);
  if (b.handled === true && !call.handledAt) {
    call.handledAt = new Date();
    call.handledBy = ctx.user._id;
    await call.save();
    if (call.lead) await logActivity(call.lead, ctx.user, { type: 'NOTE', note: 'Took the callback requested on the AI call' });
    queueAiCallSync(call._id);
  }
  return { ok: true, handledAt: call.handledAt };
});
