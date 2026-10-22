// Office-line calls ("click to call"): a sales person presses Call on a lead in the CRM; VoBiz rings the sales
// person's own mobile first, and when they pick up it dials the lead and connects them. The whole conversation is
// recorded, copied to R2, transcribed with speakers and summarised for the CRM. The lead sees the company number.
//
// CRM -> POST /api/bridge  { agent: { id, name, phone }, lead: { id, name, phone }, activityId }  -> { callId }
// VoBiz -> /vobiz/bridge (agent picked up: XML that records and dials the lead), /vobiz/bridge-event (lead leg events),
//          /vobiz/bridge-result (final Dial result), /vobiz/bridge-recording (finished recording)
// worker -> CRM webhook: bridge.status { status: RINGING_LEAD | CONNECTED | ENDED | NO_ANSWER | BUSY | FAILED | AGENT_NO_ANSWER },
//           bridge.recording, bridge.summary

import { vobizHeaders, crmEvent, esc, xml, targetFor, transcribeTransfer } from './transfer.js';

const E164_IN = /^\+91[6-9]\d{9}$/;
const cb = (env, path, callId) => `${env.PUBLIC_URL}${path}?call=${encodeURIComponent(callId)}&t=${encodeURIComponent(env.STAGING_TOKEN)}`;

/** Start an office-line call: ring the sales person first. */
export async function startBridge(req, env, { setMeta }) {
  const b = await req.json().catch(() => ({}));
  const agent = b.agent || {}, lead = b.lead || {};
  if (!E164_IN.test(agent.phone || '') || !E164_IN.test(lead.phone || '')) return Response.json({ error: 'agent.phone and lead.phone must be Indian mobiles in +91 format' }, { status: 400 });
  if (!env.VOBIZ_NUMBER) return Response.json({ error: 'VOBIZ_NUMBER is not set' }, { status: 503 });
  const t = encodeURIComponent(env.STAGING_TOKEN);
  const res = await fetch(`https://api.vobiz.ai/api/v1/Account/${env.VOBIZ_AUTH_ID}/Call/`, {
    method: 'POST', headers: { ...vobizHeaders(env), 'Content-Type': 'application/json' },
    body: JSON.stringify({
      from: env.VOBIZ_NUMBER, to: agent.phone, caller_name: 'Shine CRM',
      answer_url: `${env.PUBLIC_URL}/vobiz/bridge?t=${t}`, answer_method: 'POST',
      hangup_url: `${env.PUBLIC_URL}/vobiz/hangup?t=${t}`, hangup_method: 'POST',
      time_limit: 3600, // no hangup_on_ring: VoBiz counts it from ring start and cut answered calls ("Scheduled Hangup")
    }),
  });
  const out = await res.json().catch(() => ({}));
  if (!res.ok || !out.request_uuid) return Response.json({ error: out.error || out.message || `VoBiz HTTP ${res.status}` }, { status: 502 });
  const callId = out.request_uuid;
  await setMeta(env, callId, { callId, bridge: {
    activityId: String(b.activityId || ''), agentId: String(agent.id || ''), agentName: String(agent.name || '').slice(0, 80),
    leadId: String(lead.id || ''), leadName: String(lead.name || '').slice(0, 120), leadPhone: lead.phone, startedAt: Date.now(),
  } });
  return Response.json({ callId });
}

/** VoBiz callbacks for office-line calls. Returns a Response, or null when the path is not a bridge path. */
export async function bridgeRoute(url, req, env, ctx, { getMeta, setMeta, formOrJson, archiveRecording }) {
  const callId = url.searchParams.get('call') || '';
  const p = req.method === 'POST' ? await formOrJson(req) : {};
  const id = url.pathname === '/vobiz/bridge' ? String(p.CallUUID || '') : callId;
  if (!/^[a-zA-Z0-9-]{8,64}$/.test(id)) return new Response('Bad call id', { status: 400 });
  const meta = await getMeta(env, id);
  const br = meta.bridge;
  if (!br) return url.pathname === '/vobiz/bridge' ? xml('\n  <Hangup/>\n') : new Response('OK');
  const status = (s, extra = {}) => ctx.waitUntil(crmEvent(env, { event: 'bridge.status', callId: id, activityId: br.activityId, status: s, ...extra }));

  // The sales person picked up: record everything from here, then dial the lead with the company number.
  if (url.pathname === '/vobiz/bridge') {
    status('RINGING_LEAD');
    return new Response(`<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Record recordSession="true" fileFormat="mp3" maxLength="3600" timeout="3600" playBeep="false" redirect="false" callbackUrl="${esc(cb(env, '/vobiz/bridge-recording', id))}" callbackMethod="POST"/>
  <Dial callerId="${esc(env.VOBIZ_NUMBER)}" timeout="35" timeLimit="3600"
        action="${esc(cb(env, '/vobiz/bridge-result', id))}" method="POST"
        callbackUrl="${esc(cb(env, '/vobiz/bridge-event', id))}" callbackMethod="POST">
    <Number>${esc(br.leadPhone)}</Number>
  </Dial>
</Response>`, { headers: { 'Content-Type': 'application/xml' } });
  }

  // Lead leg: answered, hung up.
  if (url.pathname === '/vobiz/bridge-event') {
    const ev = String(p.Event || p.DialAction || '').toLowerCase();
    if (/connected|answer/.test(ev) && !meta.bridgeConnectedAt) {
      await setMeta(env, id, { bridgeConnectedAt: Date.now() });
      status('CONNECTED');
    } else if (/hangup/.test(ev) && meta.bridgeConnectedAt && !meta.bridgeEndedAt && targetFor({ targets: [{ phone: br.leadPhone }] }, p.DialBLegTo || p.To)) {
      const talkSec = Number(p.DialBLegDuration || p.Duration || p.BillDuration) || Math.round((Date.now() - meta.bridgeConnectedAt) / 1000);
      await setMeta(env, id, { bridgeEndedAt: Date.now() });
      status('ENDED', { talkSec });
    }
    return new Response('OK');
  }

  // Final Dial result: hang up the sales person's leg too; report a lead who didn't pick up.
  if (url.pathname === '/vobiz/bridge-result') {
    const s = String(p.DialStatus || '').toLowerCase();
    if (s !== 'completed' && !meta.bridgeConnectedAt) status(s === 'busy' ? 'BUSY' : /no-answer|timeout|cancel/.test(s) ? 'NO_ANSWER' : 'FAILED', { reason: p.DialHangupCause || s });
    else if (meta.bridgeConnectedAt && !meta.bridgeEndedAt) {
      await setMeta(env, id, { bridgeEndedAt: Date.now() });
      status('ENDED', { talkSec: Math.round((Date.now() - meta.bridgeConnectedAt) / 1000) });
    }
    return xml('\n  <Hangup/>\n');
  }

  // Finished recording: keep it, transcribe it, summarise it.
  if (url.pathname === '/vobiz/bridge-recording') {
    const rec = { id: p.RecordingID || p.recording_id, url: p.RecordUrl || p.RecordFile || p.record_url, durationSec: Number(p.RecordingDuration || p.recording_duration) || undefined };
    if (!rec.url) return xml('');
    await setMeta(env, id, { bridgeRecordingId: rec.id, bridgeRecordingUrl: rec.url });
    ctx.waitUntil((async () => {
      const key = await archiveRecording(env, id, rec.url, 'bridge');
      await crmEvent(env, { event: 'bridge.recording', callId: id, activityId: br.activityId, recording: { id: rec.id, durationSec: rec.durationSec } });
      if (!(await getMeta(env, id)).bridgeConnectedAt) return; // the lead never picked up: nothing to transcribe
      try {
        const obj = key ? await env.RECORDINGS.get(key) : null;
        const audio = obj ? await obj.arrayBuffer() : await (await fetch(rec.url, { headers: vobizHeaders(env) })).arrayBuffer();
        const out = await transcribeTransfer(env, audio, `Team member (made the call): ${br.agentName || 'unknown'}. Customer: ${br.leadName || br.leadPhone}.`);
        await crmEvent(env, { event: 'bridge.summary', callId: id, activityId: br.activityId, ...out });
      } catch (err) { console.error('bridge transcript', id, err.message); }
    })());
    return xml('');
  }
  return null;
}

/** The sales person's phone was not answered (VoBiz hangup URL on the first leg). */
export function bridgeHangup(env, ctx, callId, meta, p) {
  const answered = String(p.CallStatus || '').toLowerCase() === 'completed';
  if (!answered) ctx.waitUntil(crmEvent(env, { event: 'bridge.status', callId, activityId: meta.bridge.activityId, status: 'AGENT_NO_ANSWER', reason: p.HangupCause || p.CallStatus }));
  else if (meta.bridgeConnectedAt && !meta.bridgeEndedAt) {
    ctx.waitUntil(crmEvent(env, { event: 'bridge.status', callId, activityId: meta.bridge.activityId, status: 'ENDED', talkSec: Math.round((Date.now() - meta.bridgeConnectedAt) / 1000) }));
  }
}

/** CRM asks to end an office-line call (Hang up button). */
export async function hangupCall(req, env) {
  const b = await req.json().catch(() => ({}));
  if (!/^[a-zA-Z0-9-]{8,64}$/.test(b.callId || '')) return Response.json({ error: 'callId required' }, { status: 400 });
  const res = await fetch(`https://api.vobiz.ai/api/v1/Account/${env.VOBIZ_AUTH_ID}/Call/${b.callId}/`, { method: 'DELETE', headers: vobizHeaders(env) });
  return Response.json({ ok: res.ok || res.status === 404, status: res.status });
}
