// Simulated VoBiz call where the caller asks for a person: checks the agent says the hand-off line (without the tag)
// and then, with nobody reachable, stays on the line and offers a callback. No real call is placed.
// Usage: node test/transfer-sim.mjs [base-url]   (watch `wrangler tail` for "transfer" / CRM lines)
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';

const here = dirname(fileURLToPath(import.meta.url));
const env = Object.fromEntries(readFileSync(join(here, '../../.env'), 'utf8').split(/\r?\n/)
  .filter((l) => /^[A-Z_]+=/.test(l)).map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]));
const BASE = process.argv[2] || 'https://shine-voice-staging.shineinfosolutions1.workers.dev';
const log = (...a) => console.log(new Date().toISOString().slice(11, 23), ...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function say16k(text, name) {
  const f = join(tmpdir(), `shine-voice-${name}.pcm`);
  if (!existsSync(f)) {
    const r = await fetch(`${env.RUMIK_GATEWAY_URL}/v1/tts`, { method: 'POST', headers: { Authorization: `Bearer ${env.RUMIK_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'mulberry', text, audio_format: 'pcm', description: 'a calm Indian male caller, natural Hinglish', speaker: 'Lucas' }) });
    if (!r.ok) throw new Error(`Rumik ${r.status}`);
    writeFileSync(f, Buffer.from(await r.arrayBuffer()));
  }
  const b = readFileSync(f), src = new Int16Array(b.buffer, b.byteOffset, b.byteLength >> 1), out = new Int16Array(Math.floor(src.length * 2 / 3));
  for (let k = 0; k < out.length; k++) { const p = k * 1.5, j = Math.floor(p); out[k] = src[j] + ((src[Math.min(j + 1, src.length - 1)] - src[j]) * (p - j)); }
  return out;
}

const ask = await say16k('Mujhe aapki team ke kisi insaan se baat karni hai, please connect kar dijiye.', 'ask-person');
const callId = crypto.randomUUID();
const ans = await fetch(`${BASE}/vobiz/answer?t=${encodeURIComponent(env.STAGING_TOKEN)}`, { method: 'POST', body: new URLSearchParams({ CallUUID: callId, From: '918065354620', To: '919999999999' }) });
const wsUrl = /<Stream[^>]*>([^<]+)<\/Stream>/.exec(await ans.text())[1].trim().replace(/&amp;/g, '&');
const ws = new WebSocket(wsUrl);
const streamId = crypto.randomUUID();
let plays = 0, playingUntil = 0;
const checkpoints = [];
ws.onmessage = (e) => {
  const m = JSON.parse(e.data);
  if (m.event === 'playAudio') { plays++; playingUntil = Math.max(playingUntil, Date.now()) + Buffer.from(m.media.payload, 'base64').length / 48; }
  if (m.event === 'checkpoint') { checkpoints.push(m.name); setTimeout(() => ws.readyState === 1 && ws.send(JSON.stringify({ event: 'playedStream', streamId, name: m.name })), Math.max(0, playingUntil - Date.now())); }
};
await new Promise((r) => { ws.onopen = r; });
ws.send(JSON.stringify({ event: 'start', start: { callId, streamId, tracks: ['inbound'], mediaFormat: { encoding: 'audio/x-l16', sampleRate: 16000 } } }));
let speech = null, pos = 0, done = null, sent = 0;
const t0 = Date.now();
const mic = setInterval(() => {
  const owed = Math.floor((Date.now() - t0) / 20) - sent;
  for (let k = 0; k < owed; k++, sent++) {
    const f = new Int16Array(320);
    if (speech) { f.set(speech.subarray(pos, pos + 320)); pos += 320; if (pos >= speech.length) { speech = null; done?.(); } }
    ws.send(JSON.stringify({ event: 'media', streamId, media: { payload: Buffer.from(f.buffer).toString('base64') } }));
  }
}, 10);
const until = async (pred, ms) => { const end = Date.now() + ms; while (!pred() && Date.now() < end) await sleep(100); return pred(); };

const results = [];
const check = (name, ok, detail = '') => { results.push(ok); log(ok ? 'PASS' : 'FAIL', name, detail); };
await until(() => checkpoints.length >= 1, 15000);
await until(() => Date.now() > playingUntil + 300, 15000);
await new Promise((r) => { speech = ask; pos = 0; done = r; });
check('Agent answers the request with a hand-off line', await until(() => checkpoints.length >= 2, 20000), checkpoints.join(','));
check('With nobody reachable it stays on the line and asks for a callback time', await until(() => checkpoints.length >= 3, 30000), checkpoints.join(','));
await until(() => Date.now() > playingUntil + 500, 20000);
clearInterval(mic);
ws.close(1000);
await sleep(9000);
const tr = await (await fetch(`${BASE}/api/transcripts?sid=${callId}&t=${encodeURIComponent(env.STAGING_TOKEN)}`)).json();
const lines = tr[0]?.transcript || [];
for (const m of lines) log(m.role === 'user' ? 'CALLER' : 'AGENT ', m.content);
check('The tag is never in what the agent said', !lines.some((m) => /TRANSFER|\[\[/.test(m.content)));
check('Hand-off sentence, then callback offer', lines.some((m) => m.role === 'assistant' && /jod|connect/i.test(m.content)) && lines.some((m) => m.role === 'assistant' && /callback|call back|kab call/i.test(m.content)));
console.log(`${results.filter(Boolean).length}/${results.length} checks passed`);
process.exit(results.every(Boolean) ? 0 : 1);
