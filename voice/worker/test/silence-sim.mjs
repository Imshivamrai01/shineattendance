// Simulated VoBiz call where the caller never speaks: the agent should ask once whether they can hear,
// then say goodbye and hang up (instead of holding the line until the time limit). Usage: node test/silence-sim.mjs [base-url]
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const env = Object.fromEntries(readFileSync(join(here, '../../.env'), 'utf8').split(/\r?\n/)
  .filter((l) => /^[A-Z_]+=/.test(l)).map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]));
const BASE = process.argv[2] || 'https://shine-voice-staging.shineinfosolutions1.workers.dev';
const callId = crypto.randomUUID();
const ans = await fetch(`${BASE}/vobiz/answer?t=${encodeURIComponent(env.STAGING_TOKEN)}`, { method: 'POST', body: new URLSearchParams({ CallUUID: callId, From: '918065354620', To: '919999999999' }) });
const ws = new WebSocket(/<Stream[^>]*>([^<]+)<\/Stream>/.exec(await ans.text())[1].trim().replace(/&amp;/g, '&'));
const streamId = crypto.randomUUID();
const checkpoints = [];
let playingUntil = 0;
ws.onmessage = (e) => {
  const m = JSON.parse(e.data);
  if (m.event === 'playAudio') playingUntil = Math.max(playingUntil, Date.now()) + Buffer.from(m.media.payload, 'base64').length / 48;
  if (m.event === 'checkpoint') { checkpoints.push({ name: m.name, at: Date.now() }); setTimeout(() => ws.readyState === 1 && ws.send(JSON.stringify({ event: 'playedStream', streamId, name: m.name })), Math.max(0, playingUntil - Date.now())); }
};
await new Promise((r) => { ws.onopen = r; });
const t0 = Date.now();
ws.send(JSON.stringify({ event: 'start', start: { callId, streamId, tracks: ['inbound'], mediaFormat: { encoding: 'audio/x-l16', sampleRate: 16000 } } }));
let sent = 0;
const mic = setInterval(() => { const owed = Math.floor((Date.now() - t0) / 20) - sent; for (let k = 0; k < owed; k++, sent++) ws.send(JSON.stringify({ event: 'media', streamId, media: { payload: Buffer.from(new Int16Array(320).buffer).toString('base64') } })); }, 10);
await new Promise((r) => setTimeout(r, 50000));
clearInterval(mic);
ws.close(1000);
await new Promise((r) => setTimeout(r, 9000));
const lines = (await (await fetch(`${BASE}/api/transcripts?sid=${callId}&t=${encodeURIComponent(env.STAGING_TOKEN)}`)).json())[0]?.transcript || [];
for (const m of lines) console.log(m.role === 'user' ? 'CALLER' : 'AGENT ', m.content);
const ok = [checkpoints.length >= 3, lines.some((m) => /sun pa rahe/.test(m.content)), lines.some((m) => /baad mein call/.test(m.content))];
console.log(`checkpoints at ${checkpoints.map((c) => `${c.name}@${Math.round((c.at - t0) / 1000)}s`).join(', ')}`);
console.log(`${ok.filter(Boolean).length}/3 checks passed (greeting, "can you hear me?", goodbye)`);
process.exit(ok.every(Boolean) ? 0 : 1);
