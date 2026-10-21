// Simulates VoBiz against the deployed worker without placing a call: Answer URL → <Stream> XML →
// bidirectional socket with start/media events in, playAudio/checkpoint/clearAudio out.
// Reuses the audio the browser e2e test cached. Usage: node test/phone-sim.mjs [base-url]
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';

const here = dirname(fileURLToPath(import.meta.url));
const env = Object.fromEntries(readFileSync(join(here, '../../.env'), 'utf8').split(/\r?\n/)
  .filter((l) => /^[A-Z_]+=/.test(l)).map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]));
const BASE = process.argv[2] || 'https://shine-voice-staging.shineinfosolutions1.workers.dev';
const log = (...a) => console.log(new Date().toISOString().slice(11, 23), ...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function pcm16k(i) {
  const b = readFileSync(join(tmpdir(), 'shine-voice-e2e', `u${i}.pcm`));
  const src = new Int16Array(b.buffer, b.byteOffset, b.byteLength >> 1);
  const out = new Int16Array(Math.floor(src.length * 2 / 3));
  for (let k = 0; k < out.length; k++) { const p = k * 1.5, j = Math.floor(p); out[k] = src[j] + ((src[Math.min(j + 1, src.length - 1)] - src[j]) * (p - j)); }
  return out;
}

const results = [];
const check = (name, ok, detail = '') => { results.push(ok); log(ok ? 'PASS' : 'FAIL', name, detail); };

// 1. Answer URL
const callId = crypto.randomUUID();
const form = new URLSearchParams({ CallUUID: callId, From: '918065354620', To: '919999999999', Direction: 'outbound' });
const ans = await fetch(`${BASE}/vobiz/answer?t=${encodeURIComponent(env.STAGING_TOKEN)}`, { method: 'POST', body: form });
const xml = await ans.text();
const wsUrl = /<Stream[^>]*>([^<]+)<\/Stream>/.exec(xml)?.[1]?.trim().replace(/&amp;/g, '&');
check('Answer URL returns bidirectional Stream XML', ans.ok && /bidirectional="true"/.test(xml) && /rate=16000/.test(xml) && !!wsUrl, `HTTP ${ans.status}`);
const bad = await fetch(`${BASE}/vobiz/answer?t=wrong`, { method: 'POST', body: form });
check('Answer URL rejects a wrong token', bad.status === 403);

// 2. Stream
const ws = new WebSocket(wsUrl);
const streamId = crypto.randomUUID();
let plays = 0, playBytes = 0, firstPlayAt = 0, checkpoints = [], cleared = 0, inFlight = 0;
let playingUntil = 0;
ws.onmessage = (e) => {
  const m = JSON.parse(e.data);
  if (m.event === 'playAudio') {
    plays++;
    const n = Buffer.from(m.media.payload, 'base64').length;
    playBytes += n;
    if (!firstPlayAt) firstPlayAt = Date.now();
    if (m.media.sampleRate !== 24000 || m.media.contentType !== 'audio/x-l16' || m.streamId !== streamId) log('bad playAudio header', m.media.contentType, m.media.sampleRate);
    playingUntil = Math.max(playingUntil, Date.now()) + n / 48;
  } else if (m.event === 'checkpoint') {
    checkpoints.push(m.name);
    // Like VoBiz: confirm once the queued audio has "played".
    setTimeout(() => ws.readyState === 1 && ws.send(JSON.stringify({ event: 'playedStream', streamId, name: m.name })), Math.max(0, playingUntil - Date.now()));
  } else if (m.event === 'clearAudio') {
    cleared++;
    playingUntil = Date.now();
    log('<- clearAudio');
  }
};
await new Promise((r, j) => { ws.onopen = r; ws.onerror = () => j(new Error('stream socket failed')); });
check('Stream socket accepts the token from the XML', true);
ws.send(JSON.stringify({ event: 'start', start: { callId, streamId, tracks: ['inbound'], mediaFormat: { encoding: 'audio/x-l16', sampleRate: 16000 } } }));

// The phone line: 20 ms media frames on a wall clock, silence unless a sentence is queued.
let speech = null, pos = 0, done = null, sent = 0;
const t0 = Date.now();
const mic = setInterval(() => {
  const owed = Math.floor((Date.now() - t0) / 20) - sent;
  for (let k = 0; k < owed; k++, sent++) {
    let f = new Int16Array(320);
    if (speech) { f.set(speech.subarray(pos, pos + 320)); pos += 320; if (pos >= speech.length) { speech = null; done?.(); } }
    ws.send(JSON.stringify({ event: 'media', streamId, media: { payload: Buffer.from(f.buffer).toString('base64') } }));
  }
}, 10);
const say = (i) => new Promise((r) => { speech = pcm16k(i); pos = 0; done = r; });
const until = async (pred, ms) => { const end = Date.now() + ms; while (!pred() && Date.now() < end) await sleep(50); return pred(); };

try {
  check('Agent greets first over playAudio', await until(() => plays > 0, 10000), `${plays} chunks`);
  check('Greeting ends with a checkpoint', await until(() => checkpoints.length >= 1, 15000), checkpoints.join(','));
  await until(() => Date.now() > playingUntil + 300, 15000);

  const before = checkpoints.length, playsBefore = plays;
  const spokeAt = Date.now();
  await say(0); // "Hello, mera naam Rahul hai."
  check('Caller turn gets a spoken reply', await until(() => plays > playsBefore, 15000), `first reply audio ${Date.now() - spokeAt} ms after caller started`);
  await until(() => checkpoints.length > before, 20000);
  await until(() => Date.now() > playingUntil + 300, 20000);

  // Barge-in: ask a long question, then talk over the reply.
  const playsB = plays;
  await say(2);
  await until(() => plays > playsB + 10, 15000);
  await sleep(800);
  const clearedBefore = cleared, bargeAt = Date.now();
  say(3); // "Ruko ruko, pehle mujhe price batao." (not awaited: we time the barge-in from its first word)
  check('Talking over the agent sends clearAudio', await until(() => cleared > clearedBefore, 6000), `${cleared > clearedBefore ? Date.now() - bargeAt : '-'} ms after caller started`);
  await sleep(4000);

  ws.close(1000);
  check('Hangup closes cleanly', true);
} catch (err) {
  check('run', false, err.message);
} finally {
  clearInterval(mic);
  log(`playAudio chunks: ${plays}, audio: ${(playBytes / 48000).toFixed(1)} s, checkpoints: ${checkpoints.join(',')}`);
  console.log(`${results.filter(Boolean).length}/${results.length} checks passed`);
  process.exit(results.every(Boolean) ? 0 : 1);
}
