import { VoiceSession } from './session.js';
import { startBridge, bridgeRoute, bridgeHangup, hangupCall } from './bridge.js';
import { vobizHeaders, crmEvent, keys, dialXml, xml, sorryXml, targetFor, transcribeTransfer } from './transfer.js';

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

async function formOrJson(req) {
  const type = req.headers.get('content-type') || '';
  if (type.includes('application/json')) return req.json().catch(() => ({}));
  const f = await req.formData().catch(() => null);
  return f ? Object.fromEntries(f) : {};
}


// ---- CRM -> worker (Bearer CRM_WEBHOOK_SECRET) ----

/**
 * Dial an Indian mobile for the CRM. Body: { to: "+91XXXXXXXXXX", lead: { id?, name, purpose }, requestedBy,
 * company (what the agent knows about the company), script: { name, kind, opening, instructions, collect }, voice: { provider, sarvamSpeaker } }.
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
    // Voice for this call, chosen in the CRM: provider "auto" | "rumik" | "sarvam" and the Sarvam speaker.
    voice: b.voice && { provider: ['auto', 'rumik', 'sarvam'].includes(b.voice.provider) ? b.voice.provider : 'auto', sarvamSpeaker: String(b.voice.sarvamSpeaker || '').replace(/[^a-z_]/g, '').slice(0, 40) },
    script: b.script && {
      name: String(b.script.name || '').slice(0, 60), kind: String(b.script.kind || ''), opening: String(b.script.opening || '').slice(0, 300),
      instructions: String(b.script.instructions || '').slice(0, 3000), collect: String(b.script.collect || '').slice(0, 600),
    },
  });
  return Response.json({ callId });
}

// ---- Recordings: VoBiz deletes them after 30 days, so each one is copied into our own R2 bucket ----

const recKey = (env, callId, part = '') => (part === 'transfer' ? keys.transfer(env, callId) : part === 'bridge' ? keys.bridge(env, callId) : keys.ai(env, callId));
const REC_FIELDS = { '': ['recordingKey', 'recordingUrl'], transfer: ['transferRecordingKey', 'transferRecordingUrl'], bridge: ['bridgeRecordingKey', 'bridgeRecordingUrl'] };

/** Copy one recording from VoBiz into R2 (retries while VoBiz is still finalising the file). Returns the R2 key or null. */
async function archiveRecording(env, callId, url, part = '') {
  if (!env.RECORDINGS || !url) return null;
  const key = recKey(env, callId, part);
  if (await env.RECORDINGS.head(key)) return key;
  for (let i = 0; i < 4; i++) {
    try {
      const res = await fetch(url, { headers: vobizHeaders(env) });
      if (res.ok) {
        const body = await res.arrayBuffer();
        if (body.byteLength > 0) {
          await env.RECORDINGS.put(key, body, {
            httpMetadata: { contentType: res.headers.get('content-type') || 'audio/mpeg' },
            customMetadata: { callId, part: part || 'ai', source: 'vobiz', copiedAt: new Date().toISOString() },
          });
          await setMeta(env, callId, { [REC_FIELDS[part || ''][0]]: key });
          console.log('recording archived', key, body.byteLength);
          return key;
        }
      } else console.error('recording fetch', callId, res.status);
    } catch (err) { console.error('recording fetch', callId, err.message); }
    await new Promise((r) => setTimeout(r, 5000 * (i + 1)));
  }
  return null;
}

/**
 * Find a call's recording at VoBiz and keep it (R2), without relying on VoBiz's recording callback, which does not
 * always arrive. part '' = the AI conversation (the earliest recording on the call), 'transfer' = the part with the
 * team after a live transfer (the latest), 'bridge' = an office-line call. Returns { found, id, durationSec }.
 */
async function syncRecording(req, env) {
  const b = await req.json().catch(() => ({}));
  const callId = String(b.callId || ''), part = ['transfer', 'bridge'].includes(b.part) ? b.part : '';
  if (!SID.test(callId)) return Response.json({ error: 'callId required' }, { status: 400 });
  const res = await fetch(`https://api.vobiz.ai/api/v1/Account/${env.VOBIZ_AUTH_ID}/Recording/?call_uuid=${encodeURIComponent(callId)}&limit=20`, { headers: vobizHeaders(env) });
  if (!res.ok) return Response.json({ error: `VoBiz HTTP ${res.status}` }, { status: 502 });
  const list = ((await res.json()).objects || []).filter((r) => r.call_uuid === callId && r.recording_url)
    .sort((x, y) => Number(x.recording_start_ms) - Number(y.recording_start_ms));
  const meta = await getMeta(env, callId);
  const ID = { '': 'recordingId', transfer: 'transferRecordingId', bridge: 'bridgeRecordingId' }[part];
  const pick = list.find((r) => r.recording_id === meta[ID])
    || (part === 'transfer' ? (list.length > 1 ? list[list.length - 1] : null) : part === 'bridge' ? list[list.length - 1] : list.find((r) => r.recording_id !== meta.transferRecordingId));
  if (!pick) return Response.json({ found: false });
  await setMeta(env, callId, { [ID]: pick.recording_id, [REC_FIELDS[part][1]]: pick.recording_url });
  const key = await archiveRecording(env, callId, pick.recording_url, part);
  return Response.json({ found: true, id: pick.recording_id, durationSec: Math.round(Number(pick.recording_duration_ms) / 1000) || undefined, archived: !!key });
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
  const part = ['transfer', 'bridge'].includes(url.searchParams.get('part')) ? url.searchParams.get('part') : '';
  if (env.RECORDINGS) {
    const range = r2Range(req.headers.get('range'));
    const obj = await env.RECORDINGS.get(meta[REC_FIELDS[part][0]] || recKey(env, sid, part), range ? { range } : {});
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
  const source = meta[REC_FIELDS[part][1]];
  if (!source) return new Response('No recording', { status: 404 });
  const headers = { ...vobizHeaders(env) };
  if (req.headers.get('range')) headers.range = req.headers.get('range');
  const res = await fetch(source, { headers });
  return new Response(res.body, { status: res.status, headers: res.headers });
}

export default {
  async fetch(req, env, ctx) {
    const url = new URL(req.url);

    if (url.pathname === '/api/health') {
      return Response.json({ ok: true, model: env.GROQ_MODEL, tts: env.RUMIK_MODEL });
    }

    if (['/api/call', '/api/recording', '/api/recording/archive', '/api/recording/sync', '/api/bridge', '/api/hangup'].includes(url.pathname)) {
      const bearer = (req.headers.get('authorization') || '').replace(/^Bearer /, '');
      if (!sameToken(bearer, env.CRM_WEBHOOK_SECRET || '')) return new Response('Forbidden', { status: 403 });
      if (url.pathname === '/api/call' && req.method === 'POST') return dial(req, env, ctx);
      if (url.pathname === '/api/bridge' && req.method === 'POST') return startBridge(req, env, { setMeta });
      if (url.pathname === '/api/hangup' && req.method === 'POST') return hangupCall(req, env);
      if (url.pathname === '/api/recording/sync' && req.method === 'POST') return syncRecording(req, env);
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
      const bmeta = SID.test(callId) ? await getMeta(env, callId) : {};
      if (bmeta.bridge) { bridgeHangup(env, ctx, callId, bmeta, p); return new Response('OK'); } // office-line call
      // A call that never connected has no session to report it: tell the CRM here.
      if (SID.test(callId) && String(p.CallStatus || '').toLowerCase() !== 'completed') {
        const meta = bmeta;
        ctx.waitUntil(crmEvent(env, { event: 'call.failed', callId, direction: meta.direction, phone: meta.phone, leadId: meta.leadId, requestedBy: meta.requestedBy, purpose: meta.purpose, hangupCause: p.HangupCause || p.CallStatus }));
      }
      return new Response('OK');
    }

    // ---- Office-line calls (sales person first, then the lead) ----
    if (['/vobiz/bridge', '/vobiz/bridge-event', '/vobiz/bridge-result', '/vobiz/bridge-recording'].includes(url.pathname)) {
      if (!authed) return new Response('Forbidden', { status: 403 });
      return (await bridgeRoute(url, req, env, ctx, { getMeta, setMeta, formOrJson, archiveRecording })) || new Response('Not found', { status: 404 });
    }

    // ---- Live transfer (VoBiz callbacks; the session started it with the Transfer API) ----

    if (url.pathname.startsWith('/vobiz/') && ['/vobiz/transfer', '/vobiz/transfer-result', '/vobiz/transfer-event', '/vobiz/media', '/vobiz/transfer-recording'].includes(url.pathname)) {
      if (!authed) return new Response('Forbidden', { status: 403 });
      const callId = url.searchParams.get('call') || '';

      // Audio VoBiz plays to the caller ("nobody is free").
      if (url.pathname === '/vobiz/media') {
        const f = url.searchParams.get('f') || '';
        if (!/^[a-zA-Z0-9-]{1,80}$/.test(f)) return new Response('Bad file', { status: 400 });
        const obj = await env.RECORDINGS.get(keys.media(env, f));
        return obj ? new Response(obj.body, { headers: { 'content-type': 'audio/mpeg' } }) : new Response('Not found', { status: 404 });
      }
      if (!SID.test(callId)) return new Response('Bad call id', { status: 400 });
      const meta = await getMeta(env, callId);
      const tx = meta.transfer;
      if (!tx?.targets?.length) return url.pathname === '/vobiz/transfer' ? sorryXml(env) : new Response('OK');
      const p = req.method === 'POST' ? await formOrJson(req) : {};

      if (url.pathname === '/vobiz/transfer') return new Response(dialXml(env, callId, tx, 0, { record: true }), { headers: { 'Content-Type': 'application/xml' } });

      // B-leg lifecycle: who answered, when they hung up.
      if (url.pathname === '/vobiz/transfer-event') {
        const ev = String(p.Event || p.DialAction || '').toLowerCase();
        const who = targetFor(tx, p.DialBLegTo || p.To);
        if (/connected|answer/.test(ev) && !meta.transferConnected) {
          await setMeta(env, callId, { transferConnected: { id: who?.id, name: who?.name, at: Date.now() } });
          ctx.waitUntil(crmEvent(env, { event: 'call.transfer', callId, status: 'CONNECTED', toUserId: who?.id, toName: who?.name }));
        } else if (/hangup/.test(ev) && meta.transferConnected && who && who.id === meta.transferConnected.id) {
          const durationSec = Number(p.DialBLegDuration || p.Duration || p.BillDuration) || Math.round((Date.now() - meta.transferConnected.at) / 1000);
          ctx.waitUntil(crmEvent(env, { event: 'call.transfer', callId, status: 'ENDED', durationSec }));
        }
        return new Response('OK');
      }

      // Final Dial result: done, or ring the next person, or tell the caller nobody is free.
      if (url.pathname === '/vobiz/transfer-result') {
        const status = String(p.DialStatus || '').toLowerCase();
        const i = Number(url.searchParams.get('i')) || 0;
        if (status === 'completed' || meta.transferConnected) return xml('\n  <Hangup/>\n');
        const next = i + 1;
        if (tx.mode !== 'ALL' && next < tx.targets.length) {
          ctx.waitUntil(crmEvent(env, { event: 'call.transfer', callId, status: 'RINGING', next: true, toUserId: tx.targets[next].id, toName: tx.targets[next].name, whisper: tx.whisperText }));
          return new Response(dialXml(env, callId, tx, next, { record: false }), { headers: { 'Content-Type': 'application/xml' } });
        }
        ctx.waitUntil(crmEvent(env, { event: 'call.transfer', callId, status: 'NO_ANSWER', reason: status || 'no answer' }));
        return sorryXml(env);
      }

      // Recording of the transferred conversation: keep it in R2, then transcribe and summarise it for the CRM.
      if (url.pathname === '/vobiz/transfer-recording') {
        const rec = { id: p.RecordingID || p.recording_id, url: p.RecordUrl || p.RecordFile || p.record_url, durationSec: Number(p.RecordingDuration || p.recording_duration) || undefined };
        if (!rec.url) return xml('');
        await setMeta(env, callId, { transferRecordingId: rec.id, transferRecordingUrl: rec.url });
        ctx.waitUntil((async () => {
          const key = await archiveRecording(env, callId, rec.url, 'transfer');
          await crmEvent(env, { event: 'call.transfer.recording', callId, recording: { id: rec.id, durationSec: rec.durationSec } });
          if (!meta.transferConnected) return; // nobody picked up: nothing to transcribe
          try {
            const obj = key ? await env.RECORDINGS.get(key) : null;
            const audio = obj ? await obj.arrayBuffer() : await (await fetch(rec.url, { headers: vobizHeaders(env) })).arrayBuffer();
            const out = await transcribeTransfer(env, audio, `Team member: ${meta.transferConnected.name || 'unknown'}. Customer: ${meta.leadName || meta.phone || 'unknown'}.`);
            await crmEvent(env, { event: 'call.transfer.summary', callId, ...out });
          } catch (err) { console.error('transfer transcript', callId, err.message); }
        })());
        return xml('');
      }
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
