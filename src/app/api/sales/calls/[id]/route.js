import { salesHandler } from '@/lib/sales';
import { loadCall } from '@/lib/officeCalls';

// One call: live office-line status while it runs, then its recording, transcript and summary.
export const GET = salesHandler(async (ctx) => {
  const act = await loadCall(ctx);
  const out = act.toObject();
  out.hasRecording = !!act.bridge?.recordingId;
  return { activity: out };
});
