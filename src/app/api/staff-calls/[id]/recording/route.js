import { M } from '@/lib/db';
import { HttpError } from '@/lib/http';
import { staffHandler, loadStaffCall } from '@/lib/staffCalls';
import { fetchOfficeRecording } from '@/lib/officeCalls';
import { fetchRecording } from '@/lib/aiCalls';

// Plays a call's recording (office line or AI) after the same access check as the call. Supports Range for seeking.
export const GET = staffHandler(async (ctx) => {
  const sc = await loadStaffCall(ctx);
  const range = ctx.req.headers.get('range');
  let res;
  if (sc.bridge?.recordingId) res = await fetchOfficeRecording(sc.bridge.callId, range);
  else {
    const ai = sc.aiCall && await M.AiCall.findById(sc.aiCall).select('callId recordingId').lean();
    if (!ai?.recordingId) throw new HttpError(404, 'This call has no recording yet');
    res = await fetchRecording(ai.callId, range);
  }
  if (!res.ok && res.status !== 206) throw new HttpError(502, `Recording is not available (HTTP ${res.status})`);
  const headers = new Headers({ 'content-type': res.headers.get('content-type') || 'audio/mpeg', 'cache-control': 'private, no-store' });
  for (const h of ['content-length', 'content-range', 'accept-ranges']) if (res.headers.get(h)) headers.set(h, res.headers.get(h));
  return new Response(res.body, { status: res.status, headers });
});
