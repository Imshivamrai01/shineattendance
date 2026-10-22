import { DurableObject } from 'cloudflare:workers';
import { Buffer } from 'node:buffer';
import { crmPost, ensureSorry, startVobizTransfer, fastParams, extractModel } from './transfer.js';

/*
 * One live conversation. The browser streams 16 kHz PCM16 mic frames in; we relay them to Deepgram,
 * let Deepgram's endpointing decide when a turn is over, send the turn plus history to the LLM,
 * cut the streamed reply into sentences and speak each through one warm Rumik socket. Rumik's
 * 24 kHz PCM16 goes straight back to the browser as binary frames.
 *
 * Client -> server JSON: start, text, playback_done, heard, barge_stop, end. Binary = mic audio.
 * Server -> client JSON: ready, state, partial, final, token, audio_start, audio_end, barge_in, diag, error, ended.
 *
 * A phone call uses the same session through VoBiz's bidirectional <Stream>: inbound `media` is L16/16 kHz
 * (fed to Deepgram as is), replies go out as `playAudio` L16/24 kHz, `checkpoint` marks the end of a reply
 * and `clearAudio` is the barge-in.
 */

const DG_PARAMS = new URLSearchParams({
  model: 'nova-3', language: 'multi', encoding: 'linear16', sample_rate: '16000', channels: '1',
  interim_results: 'true', endpointing: '300', utterance_end_ms: '1000', vad_events: 'true', punctuate: 'true', numerals: 'true', // no smart_format: it writes Indian numbers US-style
});
const HISTORY_LIMIT = 24;

const LLM_TIMEOUT_MS = 15000;
const BYTES_PER_MS_24K = 48; // 24 kHz * 2 bytes
const PHONE_CHUNK = 1920;    // 40 ms of 24 kHz PCM16 per playAudio, small enough for quick barge-in

const TRANSFER_TAG = '[[TRANSFER]]';
const TRANSFER_RE = /\[\[\s*TRANSFER\s*\]\]/;
const TRANSFER_RE_ALL = /\[\[\s*TRANSFER\s*\]\]/g;
const END_TAG = '[[END]]';
const END_RE = /\[\[\s*END\s*\]\]/;
const END_RE_ALL = /\[\[\s*END\s*\]\]/g;
const SILENCE_NUDGE = 'Hello? Kya aap mujhe sun pa rahe hain?';
const SILENCE_BYE = 'Lagta hai abhi baat nahi ho paa rahi. Main baad mein call karungi. Dhanyavaad!';

const istNow = () => new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', hour: '2-digit', minute: '2-digit' });

/** Who is on the line and why, so the agent never asks for what it already knows. */
function callContext(meta) {
  if (!meta?.direction || meta.direction === 'web') return '';
  const lines = [`This is a phone call. Now it is ${istNow()} (India time).`];
  if (meta.direction === 'outbound') {
    lines.push(`You called them${meta.leadName ? `: ${meta.leadName}` : ''} at ${meta.phone}.${meta.purpose ? ` Reason for the call: ${meta.purpose}.` : ''}`);
  } else lines.push(`They called you from ${meta.phone}.`);
  lines.push('You already have their phone number: never ask for it, just confirm it if they want a call on another number.');
  lines.push(`Live transfer: if they ask to talk to a person (someone from the team, a manager, "kisi insaan se baat karao"), or you cannot help and they want someone,
reply with one short sentence such as "Ji, main aapko hamari team se jod rahi hoon, yeh call record ho rahi hai, ek moment." and end that reply with ${TRANSFER_TAG}.
Use ${TRANSFER_TAG} only in that case, never otherwise.`);
  lines.push(`Ending the call: when the conversation is over (they said bye, asked not to be called, or everything is settled), say a short goodbye and end that reply with ${END_TAG}. You hang up after it, so use it only for the final goodbye.`);
  return `
${lines.join(' ')}`;
}

/** The call type chosen in the CRM (Sales, Interview invite, Feedback...): replaces the default receptionist goal. */
function scriptBlock(meta) {
  const sc = meta?.script;
  if (!sc) return '';
  return `
This call: ${sc.name}.${sc.instructions ? ` How to handle it: ${sc.instructions}` : ''}${sc.collect ? ` Find out: ${sc.collect}` : ''}
Follow these call instructions over the general goal below whenever they differ.`;
}

const systemPrompt = (env, meta) => `You are a phone agent for ${env.BUSINESS_NAME}, speaking on a live voice call.
What you know about the company: ${meta?.company || env.BUSINESS_INFO || 'only its name. You do not know its services, prices or offers, so do not describe any. Ask what they need and offer a call back from the team.'}${scriptBlock(meta)}
Style: warm Indian-English / Hinglish, short spoken sentences, natural contractions. Never use markdown, emoji, bullet points or long lists.
Language: mirror the caller. English in English; Hindi or Hinglish in Hinglish written in Latin script.
You are a woman: in Hindi use feminine forms ("main bata deti hoon", "kar sakti hoon").
Goal: understand what they need, get their name and requirement, answer only from what you know, then offer a next step (callback, demo or transfer to a person).
Safety: never invent prices, availability, policies or personal data. If you don't know, say a team member will confirm and offer a callback.
Hand-off: offer a callback from the team when asked or when unsure. For a callback or demo, ask for a convenient day and time, then confirm it in one sentence, for example "Theek hai, maine note kar liya, hamari team aapko kal 12 baje call karegi." Never say it is already booked in a system, and never promise anything else.
Opt-out: if they ask not to be called, confirm politely and end.
If you were interrupted, the caller only heard part of your last reply: respond to what they said now.
Keep each reply to one to three short sentences.${callContext(meta)}`;

function greeting(env, meta) {
  const first = meta?.leadName ? meta.leadName.split(/\s+/)[0] : '';
  if (meta?.script?.opening) {
    // {name} / {company} placeholders from the call type; drop "{name} ji" cleanly when there is no name.
    return meta.script.opening.replace(/\s*\{name\}(\s+ji)?/g, first ? ` ${first}$1` : '').replace(/\{company\}/g, env.BUSINESS_NAME).trim();
  }
  if (meta?.direction === 'outbound') {
    const who = meta.leadName ? ` ${meta.leadName.split(/\s+/)[0]} ji` : '';
    return `Namaste${who}! Main ${env.BUSINESS_NAME} se bol rahi hoon. Kya aapke paas do minute hain?`;
  }
  return `Namaste! ${env.BUSINESS_NAME} mein aapka swagat hai. Main aapki kaise madad kar sakti hoon?`;
}
const GREETING_GUARD_MS = 1500; // a "Hello?" while picking up must not cut the greeting

const EXTRACT_PROMPT = `You read the transcript of a phone call handled by an AI agent (sales, reception, interview invite or feedback) and fill in a JSON object for the CRM.
Return only JSON with exactly these keys:
{"summary": one or two plain sentences in English,
 "name": caller's name or "",
 "company": their business / organisation or "",
 "requirement": what they want, short, or "",
 "outcome": one of "CALLBACK","INTERESTED","INFO_GIVEN","NOT_INTERESTED","OPT_OUT","NO_CONVERSATION",
 "interest": one of "HOT","WARM","COLD","NOT_INTERESTED",
 "callbackRequested": true if they asked or agreed to be called back / a demo / a specialist call,
 "callbackAt": ISO 8601 with +05:30 offset for the agreed time, or "" if no time was agreed,
 "callbackNote": short note for the sales person or "",
 "optOut": true only if they asked not to be called again,
 "accepted": for an interview invite or meeting: true if they agreed to come, false if they declined, null otherwise,
 "appointmentAt": ISO 8601 with +05:30 offset for the agreed interview / meeting time, or "",
 "rating": for a feedback call: their rating 1-5 as a number, or null,
 "feedback": for a feedback call: what they liked or want improved, short, or ""}
Use the caller's words only; do not guess a time they did not say. "NO_CONVERSATION" when the caller said nothing meaningful.`;

export class VoiceSession extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.client = null;
    this.dg = null;
    this.rumik = null;
    this.history = null;
    this.resetTurn();
    this.gen = 0;          // id of the reply being produced; bumped on every new reply
    this.active = null;    // { gen, abort, queue, spoken, audioMs, llmDone, ... } while the agent thinks or speaks
    this.utter = null;     // Rumik utterance in flight: { resolve }
    this.ending = false;
    this.phone = null;     // { streamId, callId } when this session is a VoBiz call
    this.meta = null;      // call details stored by the worker before the stream opens (direction, phone, lead)
  }

  resetTurn() {
    this.finalParts = [];
    this.turnStartAt = 0;
    this.lastPartialAt = 0;
    this.lastWordEnd = 0;
  }

  async fetch(req) {
    const path = new URL(req.url).pathname;
    if (path === '/transcripts') {
      return Response.json([...(await this.ctx.storage.list({ prefix: 'session:' })).values()]);
    }
    // Call details from the worker (dial request, Answer URL, recording callback), merged as they arrive.
    if (path === '/meta') {
      if (req.method === 'POST') {
        this.meta = { ...((await this.ctx.storage.get('meta')) || {}), ...(await req.json()) };
        await this.ctx.storage.put('meta', this.meta);
      }
      return Response.json((await this.ctx.storage.get('meta')) || {});
    }
    const pair = new WebSocketPair();
    const [browser, server] = Object.values(pair);
    server.accept();
    // A reconnect replaces the old socket; the history stays.
    try { this.client?.close(1000, 'replaced'); } catch {}
    this.client = server;
    this.ending = false;
    const phone = new URL(req.url).pathname === '/vobiz/stream';
    this.phone = phone ? { streamId: null } : null;
    server.addEventListener('message', (e) => (phone ? this.onPhone(e.data) : this.onClient(e.data)).catch((err) => this.fail('server', err)));
    server.addEventListener('close', () => {
      if (this.client !== server) return;
      // A call has no "End" button: hanging up ends and saves the conversation.
      if (phone && !this.ending) this.end().catch(() => {});
      else this.teardown('client closed');
    });
    return new Response(null, { status: 101, webSocket: browser });
  }

  send(obj) {
    if (this.phone) return this.sendPhone(obj);
    try { this.client?.send(JSON.stringify(obj)); } catch {}
  }

  // Only the events that mean something on a phone line are translated; the rest are UI-only.
  sendPhone(obj) {
    const streamId = this.phone.streamId;
    if (!streamId) return;
    const out = (o) => { try { this.client?.send(JSON.stringify(o)); } catch {} };
    if (obj.type === 'audio_end') out({ event: 'checkpoint', streamId, name: `g${obj.gen}` });
    else if (obj.type === 'barge_in') {
      out({ event: 'clearAudio', streamId });
      this.trimInterrupted(obj.gen, Date.now() - (this.interrupted?.audioStartWall || Date.now())).catch(() => {});
    } else if (obj.type === 'error' || obj.type === 'diag') console.log('call', streamId, JSON.stringify(obj));
  }

  sendAudio(buf) {
    if (!this.phone) { try { this.client?.send(buf); } catch {} return; }
    const bytes = new Uint8Array(buf);
    for (let i = 0; i < bytes.length; i += PHONE_CHUNK) {
      const payload = Buffer.from(bytes.subarray(i, i + PHONE_CHUNK)).toString('base64');
      try {
        this.client?.send(JSON.stringify({ event: 'playAudio', streamId: this.phone.streamId, media: { contentType: 'audio/x-l16', sampleRate: 24000, payload } }));
      } catch {}
    }
  }

  async onPhone(data) {
    const ev = JSON.parse(typeof data === 'string' ? data : new TextDecoder().decode(data));
    if (ev.event === 'media') {
      const buf = Buffer.from(ev.media?.payload || '', 'base64');
      return this.onClient(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
    }
    if (ev.event === 'start') {
      const fmt = ev.start?.mediaFormat || {};
      this.phone.streamId = ev.start?.streamId;
      this.phone.callId = ev.start?.callId;
      console.log('call start', this.phone.callId, JSON.stringify(fmt));
      this.meta = { ...((await this.ctx.storage.get('meta')) || {}), callId: this.phone.callId, startedAt: new Date().toISOString() };
      await this.ctx.storage.put('meta', this.meta);
      this.ctx.waitUntil(this.startRecording());
      this.ctx.waitUntil(this.toCrm({ event: 'call.started', startedAt: this.meta.startedAt }));
      if (!/l16/i.test(fmt.encoding || '') || Number(fmt.sampleRate) !== 16000) {
        console.error('unexpected inbound format', JSON.stringify(fmt)); // Deepgram is set up for L16/16 kHz
      }
      return this.start();
    }
    if (ev.event === 'playedStream' && /^g\d+$/.test(ev.name || '')) {
      return this.onClient(JSON.stringify({ type: 'playback_done', gen: Number(ev.name.slice(1)) }));
    }
  }

  state(s) { this.send({ type: 'state', state: s, t: Date.now() }); }

  fail(provider, err, code = 'provider_error') {
    console.error(provider, err?.message || err);
    this.send({ type: 'error', provider, code, message: String(err?.message || err).slice(0, 300) });
  }

  async loadHistory() {
    if (!this.history) this.history = (await this.ctx.storage.get('history')) || [];
    return this.history;
  }

  async saveHistory() {
    await this.ctx.storage.put('history', this.history.slice(-HISTORY_LIMIT * 2));
  }

  async onClient(data) {
    if (typeof data !== 'string') {
      const buf = data instanceof ArrayBuffer || ArrayBuffer.isView(data) ? data : await data.arrayBuffer();
      this.micBytes = (this.micBytes || 0) + buf.byteLength; // stream clock for latency: 16 kHz * 2 bytes
      if (this.dg?.readyState === WebSocket.OPEN) this.dg.send(buf);
      return;
    }
    const msg = JSON.parse(data);
    switch (msg.type) {
      case 'start': return this.start();
      case 'text': return this.finalizeTurn(String(msg.text || '').slice(0, 1000));
      case 'playback_done':
        if (this.active && this.active.gen === msg.gen && this.active.llmDone && !this.active.queue.length && !this.utter) {
          const done = this.active;
          this.active = null;
          this.state('listening');
          this.agentDoneAt = Date.now();
          if (done.transfer) this.ctx.waitUntil(this.startTransfer());
          else if (done.end) this.ctx.waitUntil(this.hangup('agent said goodbye'));
        }
        return;
      case 'heard': return this.trimInterrupted(msg.gen, Number(msg.ms) || 0);
      case 'barge_stop': return this.send({ type: 'diag', k: 'barge_stop_ms', v: msg.ms, gen: msg.gen });
      case 'end': return this.end();
    }
  }

  async start() {
    const t0 = Date.now();
    const history = await this.loadHistory();
    const resumed = history.length > 0;
    try {
      await Promise.all([this.openDeepgram(), this.openTts().catch((err) => console.error('tts warm-up', err.message))]);
    } catch (err) {
      return this.fail(err.provider || 'connect', err, err.code || 'connect_failed');
    }
    this.send({ type: 'ready', resumed, turns: history.filter((m) => m.role === 'user').length });
    this.send({ type: 'diag', k: 'providers_connect_ms', v: Date.now() - t0 });
    if (this.phone) this.watchSilence();
    if (!resumed) {
      // The agent speaks first.
      const text = greeting(this.env, this.meta);
      this.history.push({ role: 'assistant', content: text });
      await this.saveHistory();
      this.speakFixed(text, { greeting: true });
    } else {
      this.state('listening');
    }
  }

  async openDeepgram() {
    if (this.dg?.readyState === WebSocket.OPEN) return;
    const res = await fetch(`https://api.deepgram.com/v1/listen?${DG_PARAMS}`, {
      headers: { Upgrade: 'websocket', Authorization: `Token ${this.env.DEEPGRAM_API_KEY}` },
    });
    if (!res.webSocket) {
      const err = new Error(`Deepgram refused the stream (HTTP ${res.status})`);
      err.provider = 'deepgram';
      err.code = res.status === 401 || res.status === 403 ? 'expired_key' : 'connect_failed';
      throw err;
    }
    const ws = res.webSocket;
    ws.accept();
    this.dg = ws;
    this.micBytes = 0;
    ws.addEventListener('message', (e) => { try { this.onDeepgram(JSON.parse(e.data)); } catch (err) { this.fail('deepgram', err); } });
    ws.addEventListener('close', (e) => {
      if (this.dg !== ws) return;
      this.dg = null;
      if (!this.ending && this.client) {
        // Deepgram dropped mid-call: reconnect once, quietly.
        this.openDeepgram().catch((err) => this.fail('deepgram', err, 'stt_lost'));
      }
    });
    clearInterval(this.dgKeepAlive);
    this.dgKeepAlive = setInterval(() => {
      if (this.dg?.readyState === WebSocket.OPEN) this.dg.send(JSON.stringify({ type: 'KeepAlive' }));
    }, 5000);
  }

  onDeepgram(m) {
    if (m.type === 'Results') {
      const text = m.channel?.alternatives?.[0]?.transcript?.trim() || '';
      if (!text) {
        if (m.speech_final && this.finalParts.length) this.finalizeTurn();
        return;
      }
      const now = Date.now();
      if (!this.turnStartAt) {
        this.turnStartAt = now;
        this.send({ type: 'diag', k: 'first_partial_at', v: now });
      }
      this.lastPartialAt = now;
      this.heardAt = now;
      this.nudged = false;
      // The caller started talking over the agent (ignore single-letter noise).
      if (this.active && text.replace(/[^\p{L}\p{N}]/gu, '').length >= 2) this.bargeIn(text);
      const words = m.channel?.alternatives?.[0]?.words;
      if (words?.length) this.lastWordEnd = Math.max(this.lastWordEnd, words[words.length - 1].end || 0);
      if (m.is_final) this.finalParts.push(text);
      this.send({ type: 'partial', text: [...this.finalParts, m.is_final ? '' : text].join(' ').trim(), final: !!m.is_final });
      if (m.speech_final) this.finalizeTurn();
    } else if (m.type === 'UtteranceEnd') {
      if (this.finalParts.length) this.finalizeTurn();
    } else if (m.type === 'SpeechStarted') {
      // Voice activity while the agent talks: pause playback at once, and confirm (barge_in) or resume once words arrive.
      if (this.active?.firstAudio) this.send({ type: 'duck', gen: this.active.gen, t: Date.now() });
    }
  }

  async finalizeTurn(typed) {
    const text = (typed ?? this.finalParts.join(' ')).trim();
    const lastWordEnd = this.lastWordEnd;
    this.resetTurn();
    if (!text || this.transferring) return;
    if (this.active) this.bargeIn(text);
    const now = Date.now();
    this.send({ type: 'final', text, t: now });
    // Silence after the last word that it took to close the turn, on the audio stream's own clock.
    if (!typed && lastWordEnd) this.send({ type: 'diag', k: 'turn_finalize_ms', v: Math.round(((this.micBytes || 0) / 32000 - lastWordEnd) * 1000) });
    await this.loadHistory();
    this.history.push({ role: 'user', content: text });
    await this.saveHistory();
    this.reply(now);
  }

  // ---- reply generation ----

  newReply() {
    const gen = ++this.gen;
    this.active = { gen, abort: new AbortController(), queue: [], spoken: [], audioMs: 0, llmDone: false, text: '', firstAudio: false };
    return this.active;
  }

  speakFixed(text, { greeting = false, end = false } = {}) {
    const r = this.newReply();
    r.greeting = greeting;
    r.end = end;
    r.text = text;
    r.llmDone = true;
    r.queue.push(text);
    r.historyIndex = this.history.length - 1;
    this.state('speaking');
    this.pumpTts(r);
  }

  async reply(turnAt) {
    const r = this.newReply();
    this.state('thinking');
    const timer = setTimeout(() => r.abort.abort('timeout'), LLM_TIMEOUT_MS);
    let buf = '';
    let firstToken = true;
    try {
      const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
        method: 'POST',
        signal: r.abort.signal,
        headers: { Authorization: `Bearer ${this.env.GROQ_API_KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: this.env.GROQ_MODEL,
          stream: true,
          temperature: 0.5,
          max_completion_tokens: 400,
          ...fastParams(this.env.GROQ_MODEL),
          messages: [{ role: 'system', content: systemPrompt(this.env, this.meta) }, ...this.history.slice(-HISTORY_LIMIT)],
        }),
      });
      if (!res.ok) {
        const code = res.status === 401 ? 'expired_key' : res.status === 429 ? 'rate_limited' : 'provider_error';
        throw Object.assign(new Error(`Groq HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`), { code });
      }
      const reader = res.body.getReader();
      const dec = new TextDecoder();
      let pending = '';
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        if (this.active !== r) { reader.cancel(); return; }
        pending += dec.decode(value, { stream: true });
        const lines = pending.split('\n');
        pending = lines.pop();
        for (const line of lines) {
          if (!line.startsWith('data: ') || line === 'data: [DONE]') continue;
          const delta = JSON.parse(line.slice(6)).choices?.[0]?.delta?.content;
          if (!delta) continue;
          if (firstToken) { firstToken = false; this.send({ type: 'diag', k: 'first_token_ms', v: Date.now() - turnAt, gen: r.gen }); }
          r.text += delta;
          buf += delta;
          // The agent asks for a live transfer with a tag at the end of its reply: never speak it.
          if (TRANSFER_RE.test(buf)) { r.transfer = true; buf = buf.replace(TRANSFER_RE_ALL, ' '); }
          if (END_RE.test(buf)) { r.end = true; buf = buf.replace(END_RE_ALL, ' '); }
          this.send({ type: 'token', text: delta, gen: r.gen });
          // Speak each sentence as soon as it is complete; the very first one already at its first comma,
          // so the caller hears the agent start a few hundred ms sooner.
          let m;
          while ((m = /^([\s\S]*?[.!?।](?:\s|$))/.exec(buf))
            || (!r.queued && (m = /^([\s\S]{20,}?[,;:—–](?:\s))/.exec(buf)))
            || (buf.length > 140 && (m = /^([\s\S]{60,}?[,;:](?:\s))/.exec(buf)))) {
            this.enqueue(r, m[1]);
            r.queued = true;
            buf = buf.slice(m[1].length);
          }
        }
      }
      if (this.active !== r) return;
      if (TRANSFER_RE.test(r.text)) r.transfer = true;
      if (END_RE.test(r.text)) r.end = true;
      buf = buf.replace(/\[\[[^\]]*$/, ''); // a tag cut off at the end of the stream
      if (buf.trim()) this.enqueue(r, buf);
      r.llmDone = true;
      this.history.push({ role: 'assistant', content: r.text.replace(TRANSFER_RE_ALL, '').replace(END_RE_ALL, '').trim() });
      r.historyIndex = this.history.length - 1;
      await this.saveHistory();
      if (!r.queue.length && !this.utter) this.finishAudio(r);
    } catch (err) {
      if (this.active !== r) return; // cancelled by barge-in
      this.active = null;
      const timeout = r.abort.signal.reason === 'timeout';
      this.fail('groq', timeout ? new Error('The language model did not answer in time') : err, timeout ? 'provider_timeout' : err.code || 'provider_error');
      this.state('listening');
    } finally {
      clearTimeout(timer);
    }
  }

  enqueue(r, sentence) {
    const s = sentence.replace(/[*_#`>]/g, '').trim();
    if (!/[\p{L}\p{N}]/u.test(s)) return;
    r.queue.push(s);
    if (!this.utter) this.pumpTts(r);
  }

  // ---- Speech: Rumik or Sarvam (Bulbul), one warm socket, one utterance at a time ----

  /**
   * Which voice to use: the one chosen in the CRM for this call (meta.voice.provider), else TTS_PROVIDER, else Rumik.
   * A provider that failed with a balance / key error during this call is skipped, so the call never goes silent
   * while the other one has a key.
   */
  ttsProvider() {
    const want = this.meta?.voice?.provider || this.env.TTS_PROVIDER || 'auto';
    const has = { rumik: !!this.env.RUMIK_API_KEY, sarvam: !!this.env.SARVAM_API_KEY };
    const order = want === 'sarvam' ? ['sarvam', 'rumik'] : ['rumik', 'sarvam'];
    return order.find((x) => has[x] && !this.ttsDown?.[x]) || order.find((x) => has[x]) || 'rumik';
  }

  /** A provider can't speak for the rest of this call (no balance, bad key): stop using it and tell the CRM once. */
  ttsFailed(provider, message) {
    this.ttsDown = { ...(this.ttsDown || {}), [provider]: true };
    console.error('tts down', provider, message);
    if (provider === 'rumik') { try { this.rumik?.close(1000); } catch {} this.rumik = null; }
    if (provider === 'sarvam') { try { this.sarvam?.close(1000); } catch {} this.sarvam = null; }
    crmPost(this.env, '/api/ai/webhook', { event: 'provider.alert', provider, message: String(message).slice(0, 300) });
  }

  async openTts() {
    const provider = this.ttsProvider();
    if (provider === 'sarvam') await this.openSarvam(); else await this.openRumik();
    return provider;
  }

  async openRumik() {
    if (this.rumik?.readyState === WebSocket.OPEN) return;
    const gw = this.env.RUMIK_GATEWAY_URL;
    const mint = await fetch(`${gw}/v1/tts/ws-connect`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${this.env.RUMIK_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: 'init', model: this.env.RUMIK_MODEL }),
    });
    if (!mint.ok) {
      const err = new Error(`Rumik session HTTP ${mint.status}`);
      err.provider = 'rumik';
      err.code = mint.status === 401 || mint.status === 403 ? 'expired_key' : mint.status === 402 ? 'no_balance' : 'connect_failed';
      throw err;
    }
    const { ws_url, token } = await mint.json();
    const u = new URL(ws_url);
    u.searchParams.set('token', token);
    u.protocol = u.protocol === 'wss:' ? 'https:' : 'http:';
    const res = await fetch(u, { headers: { Upgrade: 'websocket' } });
    if (!res.webSocket) throw Object.assign(new Error(`Rumik socket refused (HTTP ${res.status})`), { provider: 'rumik', code: 'connect_failed' });
    const ws = res.webSocket;
    ws.accept();
    this.rumik = ws;
    // Binary frames can arrive as Blobs; convert in order so audio chunks never reorder.
    this.rumikChain = Promise.resolve();
    ws.addEventListener('message', (e) => {
      const d = e.data;
      this.rumikChain = this.rumikChain
        .then(() => (typeof d === 'string' || d instanceof ArrayBuffer ? d : d.arrayBuffer()))
        .then((v) => this.onRumik(v))
        .catch((err) => this.fail('rumik', err));
    });
    ws.addEventListener('close', () => {
      if (this.rumik !== ws) return;
      this.rumik = null;
      this.settleUtter('closed');
    });
  }

  onRumik(data) {
    if (typeof data !== 'string') return this.onTtsAudio(data);
    let f;
    try { f = JSON.parse(data); } catch { return; }
    if (f.type === 'done' || f.type === 'cancelled') this.settleUtter(f.type);
    else if (f.type === 'error' || f.error) {
      const message = f.message || f.error?.message || f.error || JSON.stringify(f).slice(0, 200);
      this.fail('rumik', new Error(message));
      this.settleUtter('error', { provider: 'rumik', message: String(message) });
    }
  }

  /** Sarvam Bulbul streaming: header auth, a config message, then text + flush per utterance; audio arrives as base64. */
  async openSarvam() {
    if (this.sarvam?.readyState === WebSocket.OPEN) return;
    const model = this.env.SARVAM_MODEL || 'bulbul:v4-flash';
    const res = await fetch(`https://api.sarvam.ai/text-to-speech/ws?model=${encodeURIComponent(model)}&send_completion_event=true`, {
      headers: { Upgrade: 'websocket', 'Api-Subscription-Key': this.env.SARVAM_API_KEY },
    });
    if (!res.webSocket) {
      const err = new Error(`Sarvam socket refused (HTTP ${res.status})`);
      err.provider = 'sarvam';
      err.code = res.status === 401 || res.status === 403 ? 'expired_key' : res.status === 402 || res.status === 429 ? 'no_balance' : 'connect_failed';
      throw err;
    }
    const ws = res.webSocket;
    ws.accept();
    this.sarvam = ws;
    this.sarvamCarry = null;
    ws.send(JSON.stringify({ type: 'config', data: {
      language_code: this.env.SARVAM_LANGUAGE || 'hi-IN',
      speaker: this.meta?.voice?.sarvamSpeaker || this.env.SARVAM_SPEAKER || 'simran_enhi_customer',
      speech_sample_rate: '24000', output_audio_codec: 'linear16', pace: Number(this.env.SARVAM_PACE) || 1.05,
      min_buffer_size: 30, max_chunk_length: 250,
    } }));
    clearInterval(this.sarvamPing);
    this.sarvamPing = setInterval(() => { try { if (this.sarvam === ws) ws.send(JSON.stringify({ type: 'ping' })); } catch {} }, 25000);
    ws.addEventListener('message', (e) => {
      if (typeof e.data !== 'string') return;
      let f;
      try { f = JSON.parse(e.data); } catch { return; }
      if (f.type === 'audio' && f.data?.audio) {
        let b = Buffer.from(f.data.audio, 'base64');
        // linear16 should be raw PCM; strip a WAV header if one comes along anyway.
        if (b.length > 44 && b.toString('ascii', 0, 4) === 'RIFF') { const i = b.indexOf('data'); if (i > 0) b = b.subarray(i + 8); }
        if (this.sarvamCarry) { b = Buffer.concat([this.sarvamCarry, b]); this.sarvamCarry = null; }
        if (b.length % 2) { this.sarvamCarry = b.subarray(b.length - 1); b = b.subarray(0, b.length - 1); }
        if (b.length) this.onTtsAudio(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength));
      } else if (f.type === 'event' && f.data?.event_type === 'final') {
        this.settleUtter('done');
      } else if (f.type === 'error') {
        const message = f.data?.message || JSON.stringify(f).slice(0, 200);
        this.fail('sarvam', new Error(message));
        this.settleUtter('error', { provider: 'sarvam', message: String(message) });
      }
    });
    ws.addEventListener('close', (e) => {
      if (this.sarvam !== ws) return;
      clearInterval(this.sarvamPing);
      this.sarvam = null;
      // 4xxx closes are the API refusing us (quota, auth): treat like an error so the other provider takes over.
      if (e.code >= 4000) this.settleUtter('error', { provider: 'sarvam', message: `closed ${e.code} ${e.reason || ''}` });
      else this.settleUtter('closed');
    });
  }

  /** 24 kHz PCM16 from whichever provider: forward it unless it belongs to a cancelled utterance. */
  onTtsAudio(data) {
    const r = this.active;
    if (!r || !this.utter || this.utter.gen !== r.gen || this.utter.cancelled) return; // stale audio after a cancel
    if (!r.firstAudio) {
      r.firstAudio = true;
      this.state('speaking');
      r.audioStartWall = Date.now();
      this.send({ type: 'audio_start', gen: r.gen });
      this.send({ type: 'diag', k: 'first_audio_at', v: Date.now(), gen: r.gen });
    }
    r.audioMs += data.byteLength / BYTES_PER_MS_24K;
    this.sendAudio(data);
  }

  settleUtter(how, error) {
    const u = this.utter;
    if (!u) return;
    this.utter = null;
    u.resolve({ how, error });
  }

  async pumpTts(r) {
    const FATAL = /balance|insufficient|quota|credit|unauthori|forbidden|expired|invalid.*key|no_balance|expired_key|40[123]|closed 4/i;
    let retries = 0;
    while (this.active === r && r.queue.length) {
      const text = r.queue.shift();
      let provider;
      try {
        provider = await this.openTts();
      } catch (err) {
        // Out of balance / bad key: switch to the other provider for the rest of the call when there is one.
        if (FATAL.test(`${err.code} ${err.message}`) && retries++ < 2) { this.ttsFailed(err.provider || this.ttsProvider(), err.message); r.queue.unshift(text); continue; }
        this.fail(err.provider || 'tts', err, err.code);
        break;
      }
      const done = new Promise((resolve) => { this.utter = { gen: r.gen, resolve, cancelled: false, provider }; });
      if (provider === 'sarvam') {
        this.sarvam.send(JSON.stringify({ type: 'text', data: { text } }));
        this.sarvam.send(JSON.stringify({ type: 'flush' }));
      } else {
        const payload = { text };
        if (this.env.RUMIK_MODEL === 'mulberry' && this.env.RUMIK_DESCRIPTION && !this.env.RUMIK_SPEAKER) payload.description = this.env.RUMIK_DESCRIPTION;
        if (this.env.RUMIK_SPEAKER) payload.speaker = this.env.RUMIK_SPEAKER;
        this.rumik.send(JSON.stringify(payload));
      }
      const { how, error } = await done;
      if (how === 'error' && error && FATAL.test(error.message) && retries++ < 2) {
        // Say the same sentence again with the other provider.
        this.ttsFailed(provider, error.message);
        r.queue.unshift(text);
        continue;
      }
      if (this.active === r) r.spoken.push(text);
    }
    if (this.active === r && r.llmDone && !r.queue.length) this.finishAudio(r);
  }

  finishAudio(r) {
    this.send({ type: 'audio_end', gen: r.gen, audioMs: Math.round(r.audioMs) });
    if (!r.firstAudio) {
      this.active = null;
      this.state('listening');
      this.agentDoneAt = Date.now();
      if (r.transfer) this.ctx.waitUntil(this.startTransfer());
      else if (r.end) this.ctx.waitUntil(this.hangup('agent said goodbye'));
    }
  }

  // ---- barge-in ----

  bargeIn(heardText) {
    const r = this.active;
    if (!r) return;
    if (r.greeting && (!r.audioStartWall || Date.now() - r.audioStartWall < GREETING_GUARD_MS)) return;
    this.active = null;
    r.abort.abort('barge-in');
    r.queue.length = 0;
    if (this.utter && this.utter.gen === r.gen) {
      this.utter.cancelled = true;
      if (this.utter.provider === 'sarvam') {
        const ws = this.sarvam;
        this.sarvam = null;
        try { ws?.close(1000); } catch {}
        this.settleUtter('cancelled');
      } else {
        try { this.rumik?.send(JSON.stringify({ type: 'cancel' })); } catch { this.settleUtter('cancelled'); }
      }
    }
    this.interrupted = { gen: r.gen, text: r.text, audioMs: r.audioMs, historyIndex: r.historyIndex, at: this.history?.length ?? 0, audioStartWall: r.audioStartWall };
    this.send({ type: 'barge_in', gen: r.gen, t: Date.now(), heard: heardText.slice(0, 120) });
    this.state('listening');
  }

  // The browser tells us how much of the interrupted reply was actually played; keep only that part.
  async trimInterrupted(gen, heardMs) {
    const it = this.interrupted;
    if (!it || it.gen !== gen) return;
    this.interrupted = null;
    await this.loadHistory();
    const ratio = it.audioMs > 0 ? Math.min(1, heardMs / it.audioMs) : 0;
    const kept = it.text.slice(0, Math.round(it.text.length * ratio)).trim();
    const note = kept ? `${kept}… (interrupted)` : '(interrupted before speaking)';
    const msg = { role: 'assistant', content: note };
    if (it.historyIndex != null && this.history[it.historyIndex]?.role === 'assistant') this.history[it.historyIndex] = msg;
    else this.history.splice(Math.min(it.at, this.history.length), 0, msg); // cut mid-stream: put it where it was spoken
    await this.saveHistory();
    this.send({ type: 'diag', k: 'heard_ms', v: Math.round(heardMs), gen });
  }

  // ---- ending calls: silence and goodbye ----

  /**
   * Phone calls only: if the caller says nothing for SILENCE_SEC after the agent stopped talking, ask once whether
   * they can hear; if still nothing, say goodbye and hang up. Keeps a silent line (or a machine) from holding the
   * call list until the time limit.
   */
  watchSilence() {
    clearInterval(this.silenceTimer);
    const limit = (Number(this.env.SILENCE_SEC) || 15) * 1000;
    this.heardAt = Date.now();
    this.agentDoneAt = Date.now();
    this.silenceTimer = setInterval(async () => {
      if (this.ending || this.transferring || this.active || this.utter || !this.phone) return;
      if (this.finalParts.length || Date.now() - (this.lastPartialAt || 0) < 3000) return; // the caller is mid-sentence
      const quiet = Date.now() - Math.max(this.heardAt || 0, this.agentDoneAt || 0);
      if (quiet < limit) return;
      await this.loadHistory();
      const text = this.nudged ? SILENCE_BYE : SILENCE_NUDGE;
      this.history.push({ role: 'assistant', content: text });
      await this.saveHistory();
      this.speakFixed(text, { end: this.nudged });
      this.nudged = true;
    }, 2000);
  }

  /** End the phone call from our side (VoBiz hang-up API). The stream closing then saves and reports the call. */
  async hangup(reason) {
    const callId = this.phone?.callId;
    if (!callId || this.hungUp) return;
    this.hungUp = true;
    clearInterval(this.silenceTimer);
    await new Promise((r) => setTimeout(r, 600)); // let the last words finish playing on the line
    try {
      const res = await fetch(`https://api.vobiz.ai/api/v1/Account/${this.env.VOBIZ_AUTH_ID}/Call/${callId}/`, {
        method: 'DELETE', headers: { 'X-Auth-ID': this.env.VOBIZ_AUTH_ID, 'X-Auth-Token': this.env.VOBIZ_AUTH_TOKEN },
      });
      console.log('hangup', callId, reason, res.status);
    } catch (err) { console.error('hangup', callId, err.message); }
  }

  // ---- live transfer to a person ----

  /** Instant one-liner for the person's notification: who is calling and their last request. */
  quickSummary() {
    const who = this.meta?.leadName || this.meta?.phone || 'A caller';
    const asks = (this.history || []).filter((m) => m.role === 'user').slice(-2).map((m) => m.content).join(' / ');
    return `${who}${asks ? `: ${asks.slice(0, 200)}` : ''}`;
  }

  /** The caller asked for a person: find who is free (CRM), prepare the whisper, and hand the call to VoBiz. */
  async startTransfer() {
    const callId = this.phone?.callId;
    if (!callId || this.transferring) return;
    this.transferring = true;
    const answer = await crmPost(this.env, '/api/ai/transfer', { callId });
    const targets = answer?.enabled ? answer.targets || [] : [];
    const fallBack = async (reason, text) => {
      // Stay on the line with the AI and take a callback instead.
      this.transferring = false;
      this.meta = { ...this.meta, transferUnavailable: reason };
      await this.ctx.storage.put('meta', this.meta);
      this.toCrm({ event: 'call.transfer', status: 'FAILED', reason });
      await this.loadHistory();
      this.history.push({ role: 'assistant', content: text });
      await this.saveHistory();
      this.speakFixed(text);
    };
    if (!targets.length) {
      return fallBack(answer?.reason || (answer ? 'nobody available right now' : 'could not reach the CRM'),
        'Maaf kijiye, abhi team mein koi free nahi hai. Main aapka callback note kar leti hoon. Aapko kab call karna theek rahega?');
    }
    // The caller is waiting in silence from here on: only quick steps before ringing. The summary for the person
    // goes in their CRM notification (a spoken whisper made VoBiz hang them up, see dialXml).
    const whisper = this.quickSummary();
    try { await ensureSorry(this.env); } catch (err) { console.error('transfer audio', err.message); }
    const tx = { targets, mode: answer.mode, ringSec: answer.ringSec, whisperText: whisper, startedAt: Date.now() };
    this.meta = { ...((await this.ctx.storage.get('meta')) || this.meta), transfer: tx };
    await this.ctx.storage.put('meta', this.meta);
    for (const x of answer.mode === 'ALL' ? targets : targets.slice(0, 1)) this.toCrm({ event: 'call.transfer', status: 'RINGING', toUserId: x.id, toName: x.name, whisper });
    try {
      await startVobizTransfer(this.env, callId);
      console.log('transfer started', callId, targets.map((x) => x.name).join(', '));
    } catch (err) {
      console.error('transfer', err.message);
      await fallBack('transfer could not start', 'Maaf kijiye, abhi connect nahi ho paya. Main aapka callback note kar leti hoon. Aapko kab call karna theek rahega?');
    }
  }

  // ---- calls: recording, CRM report ----

  async startRecording() {
    const { VOBIZ_AUTH_ID: id, VOBIZ_AUTH_TOKEN: token } = this.env;
    if (!id || !token || !this.phone?.callId) return;
    try {
      const res = await fetch(`https://api.vobiz.ai/api/v1/Account/${id}/Call/${this.phone.callId}/Record/`, {
        method: 'POST',
        headers: { 'X-Auth-ID': id, 'X-Auth-Token': token, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          time_limit: 1800, file_format: 'mp3', record_channel_type: 'stereo',
          callback_url: `${this.env.PUBLIC_URL}/vobiz/recording?t=${encodeURIComponent(this.env.STAGING_TOKEN)}`, callback_method: 'POST',
        }),
      });
      const out = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(`HTTP ${res.status} ${JSON.stringify(out).slice(0, 200)}`);
      this.meta = { ...this.meta, recordingId: out.recording_id, recordingUrl: out.url };
      await this.ctx.storage.put('meta', this.meta);
      console.log('recording started', this.phone.callId, out.recording_id);
    } catch (err) {
      console.error('recording failed to start', err.message);
    }
  }

  /** POST one event to the CRM; best effort with two retries (the CRM upserts, so repeats are harmless). */
  async toCrm(payload) {
    if (!this.env.CRM_WEBHOOK_URL || !this.env.CRM_WEBHOOK_SECRET) return;
    const m = this.meta || {};
    const body = JSON.stringify({ callId: m.callId || this.phone?.callId, direction: m.direction, phone: m.phone, leadId: m.leadId, requestedBy: m.requestedBy, purpose: m.purpose, ...payload });
    for (let i = 0; i < 3; i++) {
      try {
        const res = await fetch(this.env.CRM_WEBHOOK_URL, { method: 'POST', headers: { authorization: `Bearer ${this.env.CRM_WEBHOOK_SECRET}`, 'content-type': 'application/json' }, body });
        if (res.ok) return;
        console.error('CRM webhook', payload.event, res.status, (await res.text()).slice(0, 200));
        if (res.status < 500) return;
      } catch (err) { console.error('CRM webhook', payload.event, err.message); }
      await new Promise((r) => setTimeout(r, 1000 * (i + 1)));
    }
  }

  async extract(transcript) {
    const lines = transcript.map((m) => `${m.role === 'user' ? 'Caller' : 'Agent'}: ${m.content}`).join('\n');
    const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: { Authorization: `Bearer ${this.env.GROQ_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: extractModel(this.env), temperature: 0, ...fastParams(extractModel(this.env)), response_format: { type: 'json_object' },
        messages: [{ role: 'system', content: EXTRACT_PROMPT }, { role: 'user', content: `Call type: ${this.meta?.script?.name || 'Sales / reception'}${this.meta?.script?.collect ? ` (to find out: ${this.meta.script.collect})` : ''}. Call time: ${this.meta?.startedAt || ''} (now ${istNow()} India).\n\n${lines}` }],
      }),
      signal: AbortSignal.timeout(30000),
    });
    if (!res.ok) throw new Error(`Groq HTTP ${res.status}`);
    return JSON.parse((await res.json()).choices[0].message.content);
  }

  async reportCall(record) {
    let extract = {};
    const spoke = record.transcript.some((m) => m.role === 'user');
    try {
      extract = spoke ? await this.extract(record.transcript) : { outcome: 'NO_CONVERSATION', interest: 'COLD', summary: 'The call connected but the person did not speak.' };
    } catch (err) {
      console.error('extraction failed', err.message);
      extract = { summary: 'Summary unavailable (extraction failed); see transcript.' };
    }
    const startedAt = this.meta?.startedAt;
    await this.toCrm({
      event: 'call.ended', startedAt, endedAt: record.endedAt, transcript: record.transcript, extract,
      durationSec: startedAt ? (Date.parse(record.endedAt) - Date.parse(startedAt)) / 1000 : undefined,
    });
  }

  // ---- shutdown ----

  async end() {
    this.ending = true;
    await this.loadHistory();
    const turns = this.history.filter((m) => m.role === 'user').length;
    const record = { endedAt: new Date().toISOString(), turns, call: this.phone?.callId || null, transcript: this.history };
    await this.ctx.storage.put(`session:${Date.now()}`, record);
    if (this.phone) this.ctx.waitUntil(this.reportCall(record));
    await this.ctx.storage.delete('history');
    this.history = null;
    this.send({ type: 'ended', turns });
    this.teardown('ended');
    try { this.client?.close(1000, 'ended'); } catch {}
    this.client = null;
  }

  teardown(reason) {
    this.ending = true;
    clearInterval(this.silenceTimer);
    clearInterval(this.dgKeepAlive);
    if (this.active) { this.active.abort.abort(reason); this.active = null; }
    this.settleUtter('closed');
    try { this.dg?.send(JSON.stringify({ type: 'CloseStream' })); this.dg?.close(1000); } catch {}
    try { this.rumik?.send(JSON.stringify({ type: 'close' })); this.rumik?.close(1000); } catch {}
    try { clearInterval(this.sarvamPing); this.sarvam?.close(1000); } catch {}
    this.sarvam = null;
    this.dg = null;
    this.rumik = null;
    this.resetTurn();
  }
}
