import { HttpError } from '@/lib/http';
import { salesHandler } from '@/lib/sales';
import { fetchRecording, loadAiCall } from '@/lib/aiCalls';

// Plays the call recording after the same access check as the call itself. Supports Range so the player can seek.
export const GET = salesHandler(async (ctx) => {
  const call = await loadAiCall(ctx);
  if (!call.recordingId) throw new HttpError(404, 'This call has no recording yet');
  const res = await fetchRecording(call.callId, ctx.req.headers.get('range'));
  if (!res.ok && res.status !== 206) throw new HttpError(502, `Recording is not available (HTTP ${res.status})`);
  const headers = new Headers({ 'content-type': res.headers.get('content-type') || 'audio/mpeg', 'cache-control': 'private, no-store' });
  for (const h of ['content-length', 'content-range', 'accept-ranges']) if (res.headers.get(h)) headers.set(h, res.headers.get(h));
  return new Response(res.body, { status: res.status, headers });
});
