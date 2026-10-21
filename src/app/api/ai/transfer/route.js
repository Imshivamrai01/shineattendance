import { handler, readJson } from '@/lib/http';
import { requireVoiceWorker } from '@/lib/aiCalls';
import { transferTargets } from '@/lib/aiTransfer';

// The voice worker asks who to put a caller through to: { callId } -> { enabled, mode, ringSec, targets: [{ id, name, phone }] }.
export const POST = handler(async (ctx) => {
  requireVoiceWorker(ctx.req);
  const b = await readJson(ctx.req);
  return transferTargets(String(b.callId || ''));
}, { roles: false });
