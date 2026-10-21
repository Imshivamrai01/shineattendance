// Live transfer helpers shared by the worker routes (VoBiz callbacks) and the call session (which decides to transfer).

export const vobizHeaders = (env) => ({ 'X-Auth-ID': env.VOBIZ_AUTH_ID, 'X-Auth-Token': env.VOBIZ_AUTH_TOKEN });
export const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const crmBase = (env) => (env.CRM_WEBHOOK_URL ? new URL(env.CRM_WEBHOOK_URL).origin : '');
const digits10 = (p) => String(p || '').replace(/\D/g, '').slice(-10);

/** POST to the CRM with the shared secret. Returns parsed JSON, or null on failure (logged). */
export async function crmPost(env, path, body) {
  if (!crmBase(env) || !env.CRM_WEBHOOK_SECRET) return null;
  try {
    const res = await fetch(`${crmBase(env)}${path}`, {
      method: 'POST', headers: { authorization: `Bearer ${env.CRM_WEBHOOK_SECRET}`, 'content-type': 'application/json' }, body: JSON.stringify(body),
    });
    if (!res.ok) { console.error('CRM', path, body.event || '', res.status, (await res.text()).slice(0, 200)); return null; }
    return await res.json();
  } catch (err) { console.error('CRM', path, err.message); return null; }
}
export const crmEvent = (env, payload) => crmPost(env, '/api/ai/webhook', payload);

/** Speech as MP3 from Rumik, for audio VoBiz plays with <Play> (whisper, "nobody is free"). */
export async function ttsMp3(env, text) {
  const body = { model: env.RUMIK_MODEL, text, audio_format: 'mp3' };
  if (env.RUMIK_MODEL === 'mulberry' && env.RUMIK_DESCRIPTION) body.description = env.RUMIK_DESCRIPTION;
  const res = await fetch(`${env.RUMIK_GATEWAY_URL}/v1/tts`, {
    method: 'POST', headers: { Authorization: `Bearer ${env.RUMIK_API_KEY}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`Rumik HTTP ${res.status}`);
  return res.arrayBuffer();
}

/** R2 keys: <prefix>/<callId>.mp3 (AI part), <prefix>/<callId>-transfer.mp3, <prefix>/media/<callId>-whisper.mp3, <prefix>/media/sorry.mp3 */
export const keys = {
  ai: (env, id) => `${env.RECORDINGS_PREFIX || 'calls'}/${id}.mp3`,
  transfer: (env, id) => `${env.RECORDINGS_PREFIX || 'calls'}/${id}-transfer.mp3`,
  media: (env, name) => `${env.RECORDINGS_PREFIX || 'calls'}/media/${name}.mp3`,
};

export const SORRY_TEXT = 'Maaf kijiye, abhi hamari team mein koi free nahi hai. Hamari team aapko jaldi call back karegi. Dhanyavaad!';

/** Make sure the shared "nobody is free" message exists in R2. */
export async function ensureSorry(env) {
  const key = keys.media(env, 'sorry');
  if (await env.RECORDINGS.head(key)) return key;
  await env.RECORDINGS.put(key, await ttsMp3(env, SORRY_TEXT), { httpMetadata: { contentType: 'audio/mpeg' } });
  return key;
}

/** Public URL (token-protected) VoBiz uses to fetch a media file. */
export const mediaUrl = (env, name) => `${env.PUBLIC_URL}/vobiz/media?f=${encodeURIComponent(name)}&t=${encodeURIComponent(env.STAGING_TOKEN)}`;
const cb = (env, path, callId, extra = '') => `${env.PUBLIC_URL}${path}?call=${encodeURIComponent(callId)}${extra}&t=${encodeURIComponent(env.STAGING_TOKEN)}`;

/**
 * XML for the caller's leg: start recording the whole transferred conversation (first attempt only), then ring the
 * person(s). One at a time ("SEQUENTIAL": target i, the action URL moves on to i + 1) or everyone at once ("ALL").
 */
export function dialXml(env, callId, tx, i, { record }) {
  const targets = tx.mode === 'ALL' ? tx.targets : [tx.targets[i]];
  const rec = record ? `
  <Record recordSession="true" fileFormat="mp3" maxLength="3600" timeout="3600" playBeep="false" redirect="false" callbackUrl="${esc(cb(env, '/vobiz/transfer-recording', callId))}" callbackMethod="POST"/>` : '';
  return `<?xml version="1.0" encoding="UTF-8"?>
<Response>${rec}
  <Dial callerId="${esc(env.VOBIZ_NUMBER)}" timeout="${Number(tx.ringSec) || 20}" timeLimit="3600"
        confirmSound="${esc(cb(env, '/vobiz/whisper', callId))}" confirmTimeout="8"
        action="${esc(cb(env, '/vobiz/transfer-result', callId, `&i=${i}`))}" method="POST"
        callbackUrl="${esc(cb(env, '/vobiz/transfer-event', callId))}" callbackMethod="POST">
    ${targets.map((x) => `<Number>${esc(x.phone)}</Number>`).join('\n    ')}
  </Dial>
</Response>`;
}

export const xml = (inner) => new Response(`<?xml version="1.0" encoding="UTF-8"?>\n<Response>${inner}</Response>`, { headers: { 'Content-Type': 'application/xml' } });
export const sorryXml = (env) => xml(`\n  <Play>${esc(mediaUrl(env, 'sorry'))}</Play>\n  <Hangup/>\n`);

/** Which of the rung people answered, from the B-leg number VoBiz reports. */
export const targetFor = (tx, number) => (tx?.targets || []).find((x) => digits10(x.phone) === digits10(number));

/** Ask VoBiz to move the caller's leg to the transfer XML. */
export async function startVobizTransfer(env, callId) {
  const res = await fetch(`https://api.vobiz.ai/api/v1/Account/${env.VOBIZ_AUTH_ID}/Call/${callId}/`, {
    method: 'POST', headers: { ...vobizHeaders(env), 'Content-Type': 'application/json' },
    body: JSON.stringify({ legs: 'aleg', aleg_url: cb(env, '/vobiz/transfer', callId), aleg_method: 'POST' }),
  });
  if (!res.ok) throw new Error(`VoBiz transfer HTTP ${res.status} ${(await res.text()).slice(0, 200)}`);
}

const TX_SUMMARY_PROMPT = `You get a speaker-labelled transcript of a phone call between a customer and a team member of the company
(the call was put through from an AI agent). Decide which speaker is the team member (usually the one who greets as the company,
or answers questions), then return only JSON:
{"teamSpeaker": number, "summary": two or three plain English sentences: what the customer wanted, what was agreed, next step}`;

/** Transcribe the transferred conversation (Deepgram, speakers separated) and summarise it (Groq). */
export async function transcribeTransfer(env, audio, context) {
  const dg = await fetch('https://api.deepgram.com/v1/listen?model=nova-3&language=multi&diarize=true&punctuate=true&utterances=true&numerals=true', {
    method: 'POST', headers: { Authorization: `Token ${env.DEEPGRAM_API_KEY}`, 'Content-Type': 'audio/mpeg' }, body: audio,
  });
  if (!dg.ok) throw new Error(`Deepgram HTTP ${dg.status}`);
  const utts = ((await dg.json()).results?.utterances || []).filter((u) => u.transcript?.trim());
  if (!utts.length) return { transcript: [], summary: 'No conversation was picked up in the recording.' };
  // Merge consecutive lines from the same speaker.
  const lines = [];
  for (const u of utts) {
    const last = lines[lines.length - 1];
    if (last && last.speaker === u.speaker) last.text += ` ${u.transcript.trim()}`; else lines.push({ speaker: u.speaker, text: u.transcript.trim() });
  }
  const labelled = lines.map((l) => `Speaker ${l.speaker}: ${l.text}`).join('\n');
  let teamSpeaker = lines[0].speaker === 0 ? 1 : 0, summary = '';
  try {
    const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST', headers: { Authorization: `Bearer ${env.GROQ_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: env.GROQ_MODEL, temperature: 0, reasoning_effort: 'low', include_reasoning: false, response_format: { type: 'json_object' },
        messages: [{ role: 'system', content: TX_SUMMARY_PROMPT }, { role: 'user', content: `${context}\n\n${labelled}` }] }),
      signal: AbortSignal.timeout(30000),
    });
    const out = JSON.parse((await res.json()).choices[0].message.content);
    if (Number.isInteger(out.teamSpeaker)) teamSpeaker = out.teamSpeaker;
    summary = String(out.summary || '');
  } catch (err) { console.error('transfer summary', err.message); }
  return { transcript: lines.map((l) => ({ role: l.speaker === teamSpeaker ? 'team' : 'customer', content: l.text })), summary };
}
