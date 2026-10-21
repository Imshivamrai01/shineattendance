// End-to-end live-session test against the deployed staging worker.
// Speaks Rumik-generated sentences into /ws as a real-time 16 kHz "microphone", plays nothing, and checks:
// greeting first, interim captions, automatic turn finalization, streamed audio, barge-in, five-turn context, clean end.
// Usage: node test/e2e.mjs [https://shine-voice-staging.<sub>.workers.dev]
import { readFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';

const here = dirname(fileURLToPath(import.meta.url));
const env = Object.fromEntries(readFileSync(join(here, '../../.env'), 'utf8').split(/\r?\n/)
  .filter((l) => /^[A-Z_]+=/.test(l)).map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1).replace(/^"|"$/g, '')]));
const BASE = process.argv[2] || 'https://shine-voice-staging.shineinfosolutions1.workers.dev';
const CACHE = join(tmpdir(), 'shine-voice-e2e');
mkdirSync(CACHE, { recursive: true });

const TURNS = [
  'Hello, mera naam Rahul hai.',
  'Mujhe apni company ke liye attendance software chahiye.',
  'Kya aapke paas Android app bhi hai? Mujhe thoda detail mein samjhaiye.',
  'Ruko ruko, pehle mujhe price batao.',            // spoken over the agent's reply to turn 3
  'Hamari team mein pachaas log hain.',
  'Achha, mera naam kya tha aur hamari team mein kitne log hain?',
];
const BARGE_INDEX = 3;

async function utterance(text, i) {
  const f = join(CACHE, `u${i}.pcm`);
  if (!existsSync(f)) {
    const r = await fetch(`${env.RUMIK_GATEWAY_URL}/v1/tts`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${env.RUMIK_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'mulberry', text, audio_format: 'pcm', description: 'a calm Indian male caller, natural Hinglish', speaker: 'Lucas' }),
    });
    if (!r.ok) throw new Error(`Rumik ${r.status}: ${await r.text()}`);
    writeFileSync(f, Buffer.from(await r.arrayBuffer()));
  }
  // 24 kHz → 16 kHz, linear interpolation
  const b = readFileSync(f);
  const src = new Int16Array(b.buffer, b.byteOffset, b.byteLength >> 1);
  const n = Math.floor(src.length * 2 / 3);
  const out = new Int16Array(n);
  for (let k = 0; k < n; k++) {
    const p = k * 1.5, j = Math.floor(p), a = src[j], c = src[Math.min(j + 1, src.length - 1)];
    out[k] = a + (c - a) * (p - j);
  }
  return out;
}

const log = (...a) => console.log(new Date().toISOString().slice(11, 23), ...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const audio = [];
for (const [i, t] of TURNS.entries()) audio.push(await utterance(t, i)); // sequential: Rumik allows 4 concurrent requests per account
log('utterances ready:', audio.map((a) => (a.length / 16000).toFixed(1) + 's').join(' '));

const sid = crypto.randomUUID();
const ws = new WebSocket(`${BASE.replace(/^http/, 'ws')}/ws?sid=${sid}&t=${encodeURIComponent(env.STAGING_TOKEN)}`);
ws.binaryType = 'arraybuffer';

const events = [];
const waiters = [];
const metrics = { partials: 0, finals: [], replies: {}, firstAudioMs: [], bargeDetectMs: null, diag: {} };
let bargeSpeechAt = 0;
let audioStartAt = {}, audioBytes = {}, speakingNow = null, lastFinalAt = 0, seq = 0;

function waitFor(pred, ms = 30000, label = 'event') {
  const hit = events.find(pred);
  if (hit) { events.splice(events.indexOf(hit), 1); return Promise.resolve(hit); }
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`timeout waiting for ${label}`)), ms);
    waiters.push({ pred, resolve: (e) => { clearTimeout(t); resolve(e); } });
  });
}

ws.onmessage = (e) => {
  if (typeof e.data !== 'string') {
    if (speakingNow != null) audioBytes[speakingNow] = (audioBytes[speakingNow] || 0) + e.data.byteLength;
    return;
  }
  const m = JSON.parse(e.data);
  m._seq = ++seq;
  if (m.type === 'partial') metrics.partials++;
  if (m.type === 'final') { metrics.finals.push(m.text); lastFinalAt = Date.now(); }
  if (m.type === 'token') metrics.replies[m.gen] = (metrics.replies[m.gen] || '') + m.text;
  if (m.type === 'audio_start') { speakingNow = m.gen; audioStartAt[m.gen] = Date.now(); if (lastFinalAt) metrics.firstAudioMs.push(Date.now() - lastFinalAt); }
  if (m.type === 'audio_end') {
    // Pretend to play the audio in real time, then report playback done.
    const playMs = (audioBytes[m.gen] || 0) / 48;
    const left = Math.max(0, audioStartAt[m.gen] + playMs - Date.now());
    setTimeout(() => ws.send(JSON.stringify({ type: 'playback_done', gen: m.gen })), left);
  }
  if (m.type === 'duck' && metrics.duckAt == null && bargeSpeechAt) metrics.duckAt = Date.now();
  if (m.type === 'barge_in') {
    const heard = Date.now() - (audioStartAt[m.gen] || Date.now());
    ws.send(JSON.stringify({ type: 'heard', gen: m.gen, ms: heard }));
    speakingNow = null;
  }
  if (m.type === 'diag') (metrics.diag[m.k] ||= []).push(m.v);
  if (m.type === 'error') log('SERVER ERROR', m);
  if (['state', 'final', 'barge_in', 'audio_start', 'audio_end', 'ready', 'ended', 'error'].includes(m.type)) log('<-', m.type, m.state || m.text || m.heard || '', m.gen ?? '');
  const w = waiters.findIndex((x) => x.pred(m));
  if (w >= 0) waiters.splice(w, 1)[0].resolve(m); else events.push(m);
};

// The "microphone": a 20 ms frame every 20 ms; silence unless a sentence is queued.
let speech = null, speechPos = 0, speechDone = null;
const silence = new Int16Array(320);
// Frames are owed by wall-clock time, not by timer ticks (Windows timers fire late).
const micStart = Date.now();
let framesSent = 0;
const mic = setInterval(() => {
  if (ws.readyState !== WebSocket.OPEN) return;
  const owed = Math.floor((Date.now() - micStart) / 20) - framesSent;
  for (let k = 0; k < owed; k++, framesSent++) {
    let frame = silence;
    if (speech) {
      frame = speech.subarray(speechPos, speechPos + 320);
      speechPos += 320;
      if (speechPos >= speech.length) { speech = null; speechDone?.(); }
      if (frame.length < 320) { const f = new Int16Array(320); f.set(frame); frame = f; }
    }
    ws.send(frame.slice().buffer);
  }
}, 10);
const say = (pcm) => new Promise((r) => { speech = pcm; speechPos = 0; speechDone = r; });
// Only a 'listening' that arrives after the given event counts (older ones are stale).
const listening = (after) => waitFor((m) => m.type === 'state' && m.state === 'listening' && m._seq > after._seq, 60000, 'listening');

const results = [];
const check = (name, ok, detail = '') => { results.push({ name, ok, detail }); log(ok ? 'PASS' : 'FAIL', name, detail); };

try {
  await new Promise((r, j) => { ws.onopen = r; ws.onerror = () => j(new Error('socket failed to open')); });
  const t0 = Date.now();
  ws.send(JSON.stringify({ type: 'start' }));
  await waitFor((m) => m.type === 'ready', 20000, 'ready');
  log('connect+providers', Date.now() - t0, 'ms');
  const greet = await waitFor((m) => m.type === 'audio_start', 20000, 'greeting audio');
  check('Agent speaks first', !!greet);
  await listening(greet);

  for (let i = 0; i < TURNS.length; i++) {
    if (i === BARGE_INDEX) continue;
    const partialsBefore = metrics.partials;
    const finalsBefore = metrics.finals.length;
    await say(audio[i]);
    const fin = await waitFor((m) => m.type === 'final', 15000, `final ${i}`);
    if (i === 0) check('Interim captions while speaking', metrics.partials > partialsBefore + 1, `${metrics.partials - partialsBefore} partial events`);
    if (i === 0) check('Silence finalizes the turn automatically', metrics.finals.length === finalsBefore + 1, `"${fin.text}"`);
    const start = await waitFor((m) => m.type === 'audio_start', 25000, `reply audio ${i}`);

    if (i === BARGE_INDEX - 1) {
      // Let the agent talk for ~1.2 s, then talk over it.
      await sleep(1200);
      bargeSpeechAt = Date.now();
      const sayDone = say(audio[BARGE_INDEX]);
      const b = await waitFor((m) => m.type === 'barge_in', 8000, 'barge_in').catch(() => null);
      metrics.bargeDetectMs = b ? Date.now() - bargeSpeechAt : null;
      metrics.duckMs = metrics.duckAt ? metrics.duckAt - bargeSpeechAt : null;
      check('Speaking over the agent interrupts it', !!b && b.gen === start.gen, b ? `detected ${metrics.bargeDetectMs} ms after caller started` : 'no barge_in');
      await sayDone;
      const bf = await waitFor((m) => m.type === 'final', 15000, 'barge final');
      const ba = await waitFor((m) => m.type === 'audio_start', 25000, 'barge reply');
      await listening(ba);
      const reply = metrics.replies[ba.gen] || '';
      check('Reply addresses the interruption', /price|pric|kimat|keemat|cost|rate|charge|pricing|team|confirm|callback|call back/i.test(reply), `"${bf.text}" → "${reply.slice(0, 160)}"`);
      continue;
    }
    await listening(start);
  }

  const last = metrics.replies[Math.max(...Object.keys(metrics.replies).map(Number))] || '';
  check('Five-turn context kept in one session', /rahul|राहुल/i.test(last) && /(50|pachaas|pachas|fifty|पचास)/i.test(last), `"${last.slice(0, 200)}"`);
  check('Agent audio streams incrementally', Object.values(audioBytes).some((b) => b > 0) && metrics.firstAudioMs.length >= 4, `first audio after final: ${metrics.firstAudioMs.join(', ')} ms`);

  ws.send(JSON.stringify({ type: 'end' }));
  const ended = await waitFor((m) => m.type === 'ended', 10000, 'ended');
  check('End saves transcript and closes', ended.turns >= 5, `${ended.turns} user turns saved`);
} catch (err) {
  check('run', false, err.message);
} finally {
  clearInterval(mic);
  try { ws.close(); } catch {}
  const med = (a) => (a && a.length ? [...a].sort((x, y) => x - y)[Math.floor(a.length / 2)] : null);
  console.log('\n--- metrics (ms) ---');
  console.log(JSON.stringify({
    providers_connect: metrics.diag.providers_connect_ms?.[0],
    turn_finalize_median: med(metrics.diag.turn_finalize_ms),
    first_token_median: med(metrics.diag.first_token_ms),
    first_audio_after_final_median: med(metrics.firstAudioMs),
    barge_pause_from_caller_speech: metrics.duckMs,
    barge_confirm_from_caller_speech: metrics.bargeDetectMs,
    finals: metrics.finals,
  }, null, 1));
  console.log(`\n${results.filter((r) => r.ok).length}/${results.length} checks passed`);
  process.exit(results.every((r) => r.ok) ? 0 : 1);
}
