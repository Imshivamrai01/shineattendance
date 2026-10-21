import { handler, readJson } from '@/lib/http';
import { requireVoiceWorker, ingestAiEvent } from '@/lib/aiCalls';

// Events from the AI voice worker: call.started, call.ended (transcript + what the caller wanted), call.recording, call.failed.
// Authenticated with the shared secret, not a user session.
export const POST = handler(async (ctx) => {
  requireVoiceWorker(ctx.req);
  const call = await ingestAiEvent(await readJson(ctx.req));
  return { ok: true, id: call._id };
}, { roles: false });
