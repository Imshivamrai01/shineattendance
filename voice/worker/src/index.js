import { VoiceSession } from './session.js';

export { VoiceSession };

// Constant-time compare so the staging token can't be guessed byte by byte.
function sameToken(a, b) {
  if (!a || !b || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

const SID = /^[a-zA-Z0-9-]{8,64}$/;
const session = (env, sid) => env.SESSION.get(env.SESSION.idFromName(sid));
const setMeta = (env, sid, meta) => session(env, sid).fetch(new Request('https://do/meta', { method: 'POST', body: JSON.stringify(meta) }));
const getMeta = async (env, sid) => (await session(env, sid).fetch(new Request('https://do/meta'))).json();
const vobizHeaders = (env) => ({ 'X-Auth-ID': env.VOBIZ_AUTH_ID, 'X-Auth-Token': env.VOBIZ_AUTH_TOKEN });

async function formOrJson(req) {
  const type = req.headers.get('content-type') || '';
  if (type.includes('application/json')) return req.json().catch(() => ({}));
  const f = await req.formData().catch(() => null);
  return f ? Object.fromEntries(f) : {};
}

/** Tell the CRM directly (no session involved), e.g. a call that never connected. */
async function crmEvent(env, payload) {
  if (!env.CRM_WEBHOOK_URL || !env.CRM_WEBHOOK_SECRET) return;
  const res = await fetch(env.CRM_WEBHOOK_URL, {
    method: 'POST', headers: { authorization: `Bearer ${env.CRM_WEBHOOK_SECRET}`, 'content-type': 'application/json' }, body: JSON.stringify(payload),
  }).catch((err) => ({ ok: false, status: 0, text: async () => err.message }));
  if (!res.ok) console.error('CRM webhook', payload.event, res.status, (await res.text()).slice(0, 200));
}

// ---- CRM -> worker (Bearer CRM_WEBHOOK_SECRET) ----

/**
 * Dial an Indian mobile for the CRM. Body: { to: "+91XXXXXXXXXX", lead: { id?, name, purpose }, requestedBy,
 * company (what the agent knows about the company), script: { name, kind, opening, instructions, collect } }.
 */
async function dial(req, env, ctx) {
  const b = await req.json().catch(() => ({}));
  const to = String(b.to || '');
  if (!/^\+91[6-9]\d{9}$/.test(to)) return Response.json({ error: 'to must be an Indian mobile in +91 format' }, { status: 400 });
  if (!env.VOBIZ_NUMBER) return Response.json({ error: 'VOBIZ_NUMBER is not set' }, { status: 503 });
  const base = env.PUBLIC_URL;
  const t = encodeURIComponent(env.STAGING_TOKEN);
  const res = await fetch(`https://api.vobiz.ai/api/v1/Account/${env.VOBIZ_AUTH_ID}/Call/`, {
    method: 'POST',
    headers: { ...vobizHeaders(env), 'Content-Type': 'application/json' },
    body: JSON.stringify({
      from: env.VOBIZ_NUMBER, to, answer_url: `${base}/vobiz/answer?t=${t}`, answer_method: 'POST',
      hangup_url: `${base}/vobiz/hangup?t=${t}`, hangup_method: 'POST', time_limit: Number(env.CALL_TIME_LIMIT_SEC) || 600,
    }),
  });
  const out = await res.json().catch(() => ({}));
  if (!res.ok || !out.request_uuid) return Response.json({ error: out.error || out.message || `VoBiz HTTP ${res.status}` }, { status: 502 });
  const callId = out.request_uuid;
  await setMeta(env, callId, {
    callId, direction: 'outbound', phone: to, leadId: b.lead?.id, leadName: String(b.lead?.name || '').slice(0, 120),
    purpose: String(b.lead?.purpose || '').slice(0, 300), requestedBy: b.requestedBy, company: String(b.company || '').slice(0, 4000),
    script: b.script && {
      name: String(b.script.name || '').slice(0, 60), kind: String(b.script.kind || ''), opening: String(b.script.opening || '').slice(0, 300),
      instructions: String(b.script.instructions || '').slice(0, 3000), collect: String(b.script.collect || '').slice(0, 600),
    },
  });
  return Response.json({ callId });
}

// ---- Recordings: VoBiz deletes them after 30 days, so each one is copied into our own R2 bucket ----

const recKey = (env, callId) => `${env.RECORDINGS_PREFIX || 'calls'}/${callId}.mp3`;

/** Copy one recording from VoBiz into R2 (retries while VoBiz is still finalising the file). Returns the R2 key or null. */
async function archiveRecording(env, callId, url) {
  if (!env.RECORDINGS || !url) return null;
  const key = recKey(env, callId);
  if (await env.RECORDINGS.head(key)) return key;
  for (let i = 0; i < 4; i++) {
    try {
      const res = await fetch(url, { headers: vobizHeaders(env) });
      if (res.ok) {
        const body = await res.arrayBuffer();
        if (body.byteLength > 0) {
          await env.RECORDINGS.put(key, body, {
            httpMetadata: { contentType: res.headers.get('content-type') || 'audio/mpeg' },
            customMetadata: { callId, source: 'vobiz', copiedAt: new Date().toISOString() },
          });
          await setMeta(env, callId, { recordingKey: key });
          console.log('recording archived', key, body.byteLength);
          return key;
        }
      } else console.error('recording fetch', callId, res.status);
    } catch (err) { console.error('recording fetch', callId, err.message); }
    await new Promise((r) => setTimeout(r, 5000 * (i + 1)));
  }
  return null;
}

/** "bytes=a-b" / "bytes=a-" / "bytes=-n" -> R2 range option, or undefined. */
function r2Range(header) {
  const m = /^bytes=(\d*)-(\d*)$/.exec(header || '');
  if (!m || (!m[1] && !m[2])) return undefined;
  if (!m[1]) return { suffix: Number(m[2]) };
  return m[2] ? { offset: Number(m[1]), length: Number(m[2]) - Number(m[1]) + 1 } : { offset: Number(m[1]) };
}

/** Stream a call's recording to the CRM (which checks who may listen): from R2 when copied, else from VoBiz. */
async function recording(req, env, url) {
  const sid = url.searchParams.get('call') || '';
  if (!SID.test(sid)) return new Response('Bad call id', { status: 400 });
  const meta = await getMeta(env, sid);
  if (env.RECORDINGS) {
    const range = r2Range(req.headers.get('range'));
    const obj = await env.RECORDINGS.get(meta.recordingKey || recKey(env, sid), range ? { range } : {});
    if (obj) {
      const headers = new Headers({ 'content-type': obj.httpMetadata?.contentType || 'audio/mpeg', 'accept-ranges': 'bytes', etag: obj.httpEtag });
      if (range && obj.range) {
        const start = obj.range.offset ?? obj.size - obj.range.suffix;
        const len = obj.range.length ?? obj.size - start;
        headers.set('content-range', `bytes ${start}-${start + len - 1}/${obj.size}`);
        headers.set('content-length', String(len));
        return new Response(obj.body, { status: 206, headers });
      }
      headers.set('content-length', String(obj.size));
      return new Response(obj.body, { headers });
    }
  }
  if (!meta.recordingUrl) return new Response('No recording', { status: 404 });
  const headers = { ...vobizHeaders(env) };
  if (req.headers.get('range')) headers.range = req.headers.get('range');
  const res = await fetch(meta.recordingUrl, { headers });
  return new Response(res.body, { status: res.status, headers: res.headers });
}

export default {
  async fetch(req, env, ctx) {
    const url = new URL(req.url);

    if (url.pathname === '/api/health') {
      return Response.json({ ok: true, model: env.GROQ_MODEL, tts: env.RUMIK_MODEL });
    }

    if (url.pathname === '/api/call' || url.pathname === '/api/recording' || url.pathname === '/api/recording/archive') {
      const bearer = (req.headers.get('authorization') || '').replace(/^Bearer /, '');
      if (!sameToken(bearer, env.CRM_WEBHOOK_SECRET || '')) return new Response('Forbidden', { status: 403 });
      if (url.pathname === '/api/call' && req.method === 'POST') return dial(req, env, ctx);
      if (url.pathname === '/api/recording/archive' && req.method === 'POST') {
        const sid = url.searchParams.get('call') || '';
        if (!SID.test(sid)) return new Response('Bad call id', { status: 400 });
        const meta = await getMeta(env, sid);
        return Response.json({ key: await archiveRecording(env, sid, meta.recordingUrl) });
      }
      if (url.pathname === '/api/recording') return recording(req, env, url);
      return new Response('Method not allowed', { status: 405 });
    }

    const authed = sameToken(url.searchParams.get('t') || '', env.STAGING_TOKEN || '');

    // VoBiz Answer URL: start a bidirectional stream back into this worker, one session per call.
    if (url.pathname === '/vobiz/answer') {
      if (!authed) return new Response('Forbidden', { status: 403 });
      const p = req.method === 'POST' ? await formOrJson(req) : Object.fromEntries(url.searchParams);
      const callId = String(p.CallUUID || crypto.randomUUID()).replace(/[^a-zA-Z0-9-]/g, '');
      const inbound = String(p.Direction || '').toLowerCase() === 'inbound';
      const other = String((inbound ? p.From : p.To) || '').replace(/[^\d+]/g, '');
      // Outbound calls from the CRM already stored their lead details; this adds what VoBiz knows.
      await setMeta(env, callId, { callId, direction: inbound ? 'inbound' : 'outbound', ...(other ? { phone: other.startsWith('+') ? other : `+${other}` } : {}) });
      const ws = `wss://${url.host}/vobiz/stream?sid=${callId}&amp;t=${encodeURIComponent(url.searchParams.get('t'))}`;
      const xml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Stream bidirectional="true" keepCallAlive="true" contentType="audio/x-l16;rate=16000" streamTimeout="1800">${ws}</Stream>
</Response>`;
      return new Response(xml, { headers: { 'Content-Type': 'application/xml' } });
    }

    if (url.pathname === '/vobiz/hangup') {
      if (!authed) return new Response('Forbidden', { status: 403 });
      const p = await formOrJson(req);
      console.log('hangup', JSON.stringify(Object.fromEntries(Object.entries(p).filter(([k]) => /CallUUID|Duration|BillDuration|HangupCause|CallStatus|TotalCost|Rate/i.test(k)))));
      const callId = String(p.CallUUID || '');
      // A call that never connected has no session to report it: tell the CRM here.
      if (SID.test(callId) && String(p.CallStatus || '').toLowerCase() !== 'completed') {
        const meta = await getMeta(env, callId);
        ctx.waitUntil(crmEvent(env, { event: 'call.failed', callId, direction: meta.direction, phone: meta.phone, leadId: meta.leadId, requestedBy: meta.requestedBy, purpose: meta.purpose, hangupCause: p.HangupCause || p.CallStatus }));
      }
      return new Response('OK');
    }

    // VoBiz recording callback: remember where the file is and tell the CRM it can be played.
    if (url.pathname === '/vobiz/recording') {
      if (!authed) return new Response('Forbidden', { status: 403 });
      const p = await formOrJson(req);
      const callId = String(p.call_uuid || p.CallUUID || '');
      if (!SID.test(callId)) return new Response('Bad call id', { status: 400 });
      const rec = { id: p.recording_id || p.RecordingID, url: p.record_url || p.RecordUrl, durationSec: Number(p.recording_duration || p.RecordingDuration) || undefined };
      await setMeta(env, callId, { recordingId: rec.id, recordingUrl: rec.url, recordingDurationSec: rec.durationSec });
      ctx.waitUntil(crmEvent(env, { event: 'call.recording', callId, recording: rec }));
      ctx.waitUntil(archiveRecording(env, callId, rec.url));
      return new Response('OK');
    }

    // Saved transcripts of one session (a call uses its CallUUID as the session id).
    if (url.pathname === '/api/transcripts') {
      if (!authed) return new Response('Forbidden', { status: 403 });
      const sid = (url.searchParams.get('sid') || '').slice(0, 64);
      if (!SID.test(sid)) return new Response('Bad session id', { status: 400 });
      return session(env, sid).fetch(new Request('https://do/transcripts'));
    }

    if (url.pathname === '/ws' || url.pathname === '/vobiz/stream') {
      if (!authed) return new Response('Forbidden', { status: 403 });
      if (req.headers.get('Upgrade') !== 'websocket') return new Response('Expected WebSocket', { status: 426 });
      // One Durable Object per conversation; reconnecting with the same sid resumes its history.
      const sid = (url.searchParams.get('sid') || '').slice(0, 64);
      if (!SID.test(sid)) return new Response('Bad session id', { status: 400 });
      return session(env, sid).fetch(req);
    }

    return env.ASSETS.fetch(req);
  },
};
