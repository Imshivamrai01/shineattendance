import { handler, readJson } from '@/lib/http';
import { requireVoiceWorker, ingestAiEvent } from '@/lib/aiCalls';
import { ingestTransferEvent } from '@/lib/aiTransfer';

// Events from the AI voice worker: call.started, call.ended (transcript + what the caller wanted), call.recording, call.failed,
// and for a live transfer to a person: call.transfer (RINGING / CONNECTED / ENDED / NO_ANSWER), call.transfer.recording, call.transfer.summary.
// Authenticated with the shared secret, not a user session.
export const POST = handler(async (ctx) => {
  requireVoiceWorker(ctx.req);
  const ev = await readJson(ctx.req);
  const call = String(ev.event || '').startsWith('call.transfer') ? await ingestTransferEvent(ev) : await ingestAiEvent(ev);
  return { ok: true, id: call?._id || null };
}, { roles: false });
