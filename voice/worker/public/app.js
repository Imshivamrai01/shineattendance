// Live conversation client. States: idle → requesting_permission → connecting → listening ↔ thinking ↔ speaking,
// and from any active state → reconnecting | error | ending → ended.

const $ = (id) => document.getElementById(id);
const params = new URLSearchParams(location.search);
const TOKEN = params.get('t') || '';
const LABELS = {
  idle: 'Idle', requesting_permission: 'Waiting for microphone…', connecting: 'Connecting…', listening: 'Listening',
  thinking: 'Thinking…', speaking: 'Speaking', reconnecting: 'Reconnecting…', error: 'Something went wrong', ending: 'Ending…', ended: 'Conversation ended',
};
const HINTS = {
  listening: 'Speak naturally. A short pause ends your turn.', thinking: 'You can interrupt at any time.',
  speaking: 'Talk over the agent to interrupt it.', reconnecting: 'Network dropped. Retrying with backoff…',
};
const ACTIVE = new Set(['connecting', 'listening', 'thinking', 'speaking', 'reconnecting']);

// Mic capture: forward raw float frames from the audio thread to the main thread.
const WORKLET = `class Tap extends AudioWorkletProcessor {
  process(inputs) { const ch = inputs[0] && inputs[0][0]; if (ch) this.port.postMessage(ch.slice(0)); return true; }
}
registerProcessor('tap', Tap);`;

let S = 'idle';
let sid = null;
let ws = null;
let stream = null;
let ctx = null;
let playCtx = null; // separate context so playback can pause without stopping the mic
let duckTimer = null, duckAt = 0;
let node = null;
let src = null;
let retries = 0;
let retryTimer = null;
let userEnded = false;
// Downsampler state (device rate → 16 kHz, 20 ms frames)
let ratio = 3, pos = 0, out = new Int16Array(320), outLen = 0;
// Playback state
let playing = new Set(), nextAt = 0, firstStartAt = 0, playGen = -1, acceptAudio = false, audioEnded = false;
// Diagnostics clocks
let connectAt = 0, voiceAt = 0, finalAt = 0, firstAudioSeen = false, turns = 0;
let agentLi = null;

function setState(s, detail) {
  S = s;
  $('state').textContent = LABELS[s] || s;
  $('orb').dataset.s = s;
  $('hint').textContent = detail || HINTS[s] || ({ idle: 'Press Start, allow the microphone, then just talk. No send button.', ended: 'Microphone released. Press Start to talk again.' }[s] || '');
  const active = ACTIVE.has(s);
  $('start').disabled = active || s === 'requesting_permission' || s === 'ending';
  $('end').disabled = !active && s !== 'requesting_permission';
  $('typedText').disabled = $('typedSend').disabled = !['listening', 'thinking', 'speaking'].includes(s);
}

function banner(text, kind = 'err') {
  const b = $('banner');
  b.textContent = text || '';
  b.className = text ? `banner show ${kind}` : 'banner';
}

function line(cls, text) {
  $('empty')?.remove();
  const li = document.createElement('li');
  li.className = cls;
  li.textContent = text;
  $('log').appendChild(li);
  li.scrollIntoView({ block: 'nearest' });
  return li;
}

const diag = (id, v) => { $(id).textContent = v == null ? '–' : `${Math.round(v)} ms`; };

// ---------- start / end ----------

async function start() {
  userEnded = false;
  banner('');
  setState('requesting_permission');
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 },
    });
  } catch (err) {
    const denied = err.name === 'NotAllowedError' || err.name === 'SecurityError';
    const missing = err.name === 'NotFoundError' || err.name === 'OverconstrainedError';
    setState('error', denied ? 'Microphone permission was denied. Allow it in the address bar, then press Start again.'
      : missing ? 'No microphone was found. Connect one and press Start again.' : `Could not open the microphone: ${err.message}`);
    banner(denied ? 'Microphone access denied.' : missing ? 'No microphone found.' : 'Microphone error.');
    return;
  }
  ctx = new AudioContext();
  playCtx = new AudioContext();
  await ctx.audioWorklet.addModule(URL.createObjectURL(new Blob([WORKLET], { type: 'application/javascript' })));
  src = ctx.createMediaStreamSource(stream);
  node = new AudioWorkletNode(ctx, 'tap');
  ratio = ctx.sampleRate / 16000;
  node.port.onmessage = (e) => onMic(e.data);
  src.connect(node);
  sid = crypto.randomUUID();
  turns = 0; $('d_turns').textContent = '0';
  connect();
}

function connect() {
  setState(retries ? 'reconnecting' : 'connecting');
  connectAt = performance.now();
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  ws = new WebSocket(`${proto}//${location.host}/ws?sid=${sid}&t=${encodeURIComponent(TOKEN)}`);
  ws.binaryType = 'arraybuffer';
  ws.onopen = () => ws.send(JSON.stringify({ type: 'start', agent: $('agent').value }));
  ws.onmessage = (e) => (typeof e.data === 'string' ? onEvent(JSON.parse(e.data)) : onAudio(e.data));
  ws.onclose = (e) => {
    ws = null;
    if (userEnded || S === 'ended' || S === 'error') return;
    if (e.code === 1008 || e.code === 4003) return fatal('This test link is not authorised.');
    if (retries >= 5) return fatal('Lost the connection to the voice server. Check your network and press Start again.');
    stopPlayback();
    const delay = Math.min(8000, 500 * 2 ** retries++);
    setState('reconnecting', `Connection lost. Retrying in ${Math.round(delay / 1000) || 1}s… (attempt ${retries} of 5)`);
    retryTimer = setTimeout(connect, delay);
  };
}

function fatal(msg) {
  banner(msg);
  release();
  setState('error', msg);
}

function end() {
  userEnded = true;
  clearTimeout(retryTimer);
  if (ws && ws.readyState === WebSocket.OPEN) {
    setState('ending');
    ws.send(JSON.stringify({ type: 'end' }));
    setTimeout(() => { if (S === 'ending') finish(); }, 3000); // don't hang if the server never answers
  } else finish();
}

function finish() {
  release();
  setState('ended');
}

// Stop every track and audio node so the browser's mic indicator turns off.
function release() {
  clearTimeout(retryTimer);
  stopPlayback();
  try { ws?.close(1000); } catch {}
  ws = null;
  node?.port && (node.port.onmessage = null);
  try { src?.disconnect(); node?.disconnect(); } catch {}
  stream?.getTracks().forEach((t) => t.stop());
  ctx?.close().catch(() => {});
  playCtx?.close().catch(() => {});
  stream = ctx = playCtx = node = src = null;
  retries = 0;
  $('caption').textContent = '';
}

// ---------- mic → server ----------

function onMic(f32) {
  // Voice onset, only used for the "first partial" diagnostic.
  if (!voiceAt) {
    let sum = 0;
    for (let i = 0; i < f32.length; i++) sum += f32[i] * f32[i];
    if (Math.sqrt(sum / f32.length) > 0.02) voiceAt = performance.now();
  }
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  for (; pos < f32.length; pos += ratio) {
    const i = Math.floor(pos);
    const a = f32[i], b = f32[Math.min(i + 1, f32.length - 1)];
    const s = Math.max(-1, Math.min(1, a + (b - a) * (pos - i)));
    out[outLen++] = s < 0 ? s * 0x8000 : s * 0x7fff;
    if (outLen === out.length) { ws.send(out.buffer.slice(0)); outLen = 0; }
  }
  pos -= f32.length;
}

// ---------- server → speaker ----------

function onAudio(buf) {
  if (!acceptAudio || !playCtx) return;
  if (!firstAudioSeen && finalAt) { firstAudioSeen = true; diag('d_audio', performance.now() - finalAt); }
  const pcm = new Int16Array(buf);
  if (!pcm.length) return;
  const ab = playCtx.createBuffer(1, pcm.length, 24000);
  const ch = ab.getChannelData(0);
  for (let i = 0; i < pcm.length; i++) ch[i] = pcm[i] / 0x8000;
  const node = playCtx.createBufferSource();
  node.buffer = ab;
  node.connect(playCtx.destination);
  const at = Math.max(playCtx.currentTime + 0.03, nextAt);
  if (!firstStartAt) firstStartAt = at;
  node.start(at);
  nextAt = at + ab.duration;
  playing.add(node);
  node.onended = () => { playing.delete(node); maybeDone(); };
}

function maybeDone() {
  if (audioEnded && !playing.size && ws?.readyState === WebSocket.OPEN) {
    audioEnded = false;
    ws.send(JSON.stringify({ type: 'playback_done', gen: playGen }));
  }
}

function heardMs() {
  return playCtx && firstStartAt ? Math.max(0, (playCtx.currentTime - firstStartAt) * 1000) : 0;
}

function stopPlayback() {
  clearTimeout(duckTimer);
  if (playCtx?.state === 'suspended') playCtx.resume().catch(() => {});
  for (const n of playing) { try { n.onended = null; n.stop(); } catch {} }
  playing.clear();
  nextAt = 0;
  acceptAudio = false;
}

// ---------- events ----------

function onEvent(m) {
  switch (m.type) {
    case 'ready':
      retries = 0;
      diag('d_connect', performance.now() - connectAt);
      banner(m.resumed ? 'Reconnected. The conversation picks up where it left off.' : '', 'warn');
      if (m.resumed) line('sys', 'Reconnected, context kept');
      break;
    case 'state':
      if (ACTIVE.has(S)) setState(m.state);
      break;
    case 'partial':
      if (!voiceAt) voiceAt = performance.now();
      if ($('d_partial').dataset.turn !== String(turns)) {
        $('d_partial').dataset.turn = String(turns);
        diag('d_partial', performance.now() - voiceAt);
      }
      $('caption').textContent = m.text;
      break;
    case 'final':
      $('caption').textContent = '';
      line('user', m.text);
      turns++; $('d_turns').textContent = String(turns);
      finalAt = performance.now();
      firstAudioSeen = false;
      voiceAt = 0;
      agentLi = null;
      break;
    case 'token':
      if (!agentLi || agentLi.dataset.gen !== String(m.gen)) { agentLi = line('agent', ''); agentLi.dataset.gen = String(m.gen); }
      agentLi.textContent += m.text;
      break;
    case 'audio_start':
      stopPlayback();
      playGen = m.gen;
      acceptAudio = true;
      audioEnded = false;
      firstStartAt = 0;
      if (!agentLi || agentLi.dataset.gen !== String(m.gen)) { agentLi = null; }
      break;
    case 'audio_end':
      if (m.gen === playGen) { audioEnded = true; maybeDone(); }
      break;
    case 'duck':
      // Pause right away; resume if no words follow (a cough, background noise).
      if (m.gen !== playGen || !playCtx) break;
      duckAt = performance.now();
      playCtx.suspend().then(() => diag('d_barge', performance.now() - duckAt)).catch(() => {});
      clearTimeout(duckTimer);
      duckTimer = setTimeout(() => playCtx?.resume().catch(() => {}), 1500);
      break;
    case 'barge_in': {
      const t0 = performance.now();
      const heard = heardMs();
      stopPlayback();
      const stopMs = performance.now() - t0;
      if (!duckAt) diag('d_barge', stopMs);
      duckAt = 0;
      ws?.send(JSON.stringify({ type: 'heard', gen: m.gen, ms: heard }));
      ws?.send(JSON.stringify({ type: 'barge_stop', gen: m.gen, ms: stopMs }));
      if (agentLi && agentLi.dataset.gen === String(m.gen)) agentLi.textContent += ' …';
      line('sys', 'Interrupted');
      break;
    }
    case 'diag':
      if (m.k === 'turn_finalize_ms') diag('d_final', m.v);
      if (m.k === 'first_token_ms') diag('d_token', m.v);
      break;
    case 'error': {
      const msg = {
        expired_key: `The ${m.provider} key was rejected. Update it on the server.`,
        provider_timeout: `${m.provider} took too long to answer. Try again.`,
        rate_limited: `${m.provider} is rate-limiting us. Wait a moment.`,
        stt_lost: 'Speech recognition dropped and could not reconnect.',
      }[m.code] || `${m.provider}: ${m.message}`;
      banner(msg);
      if (m.code === 'expired_key' || m.code === 'connect_failed') { userEnded = true; release(); setState('error', msg); }
      break;
    }
    case 'ended':
      line('sys', `Saved transcript (${m.turns} turn${m.turns === 1 ? '' : 's'})`);
      finish();
      break;
  }
}

// ---------- wiring ----------

$('start').addEventListener('click', () => {
  // Clear the transcript of the last session.
  $('log').innerHTML = '<li class="empty" id="empty">Starting…</li>';
  ['d_connect', 'd_partial', 'd_final', 'd_token', 'd_audio', 'd_barge'].forEach((id) => diag(id, null));
  start();
});
$('end').addEventListener('click', end);
$('typed').addEventListener('submit', (e) => {
  e.preventDefault();
  const text = $('typedText').value.trim();
  if (!text || !ws) return;
  ws.send(JSON.stringify({ type: 'text', text }));
  $('typedText').value = '';
});
// Never leave the mic open after navigation.
addEventListener('pagehide', () => { userEnded = true; if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'end' })); release(); });
if (!TOKEN) banner('This page needs its test link (with ?t=…) to connect.', 'warn');
setState('idle');
