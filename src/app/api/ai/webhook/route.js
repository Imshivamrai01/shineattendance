import { handler, readJson } from '@/lib/http';
import { requireVoiceWorker, ingestAiEvent, providerAlert } from '@/lib/aiCalls';
import { ingestTransferEvent } from '@/lib/aiTransfer';
import { ingestBridgeEvent } from '@/lib/officeCalls';
import { ingestStaffBridgeEvent } from '@/lib/staffCalls';

// Events from the AI voice worker: call.started, call.ended (transcript + what the caller wanted), call.recording, call.failed,
// and for a live transfer to a person: call.transfer (RINGING / CONNECTED / ENDED / NO_ANSWER), call.transfer.recording, call.transfer.summary;
// provider.alert when a voice provider stops working (no balance, bad key);
// bridge.status / bridge.recording / bridge.summary for office-line calls (caller's phone first, then the lead or employee).
// Authenticated with the shared secret, not a user session.
export const POST = handler(async (ctx) => {
  requireVoiceWorker(ctx.req);
  const ev = await readJson(ctx.req);
  if (ev.event === 'provider.alert') return providerAlert(ev);
  if (String(ev.event || '').startsWith('bridge.')) { const act = (await ingestBridgeEvent(ev)) || (await ingestStaffBridgeEvent(ev)); return { ok: true, id: act?._id || null }; }
  const call = String(ev.event || '').startsWith('call.transfer') ? await ingestTransferEvent(ev) : await ingestAiEvent(ev);
  return { ok: true, id: call?._id || null };
}, { roles: false });
