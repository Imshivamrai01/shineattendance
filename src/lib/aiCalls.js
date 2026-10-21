import crypto from 'node:crypto';
import { M, getSettings, defer } from './db.js';
import { HttpError, bad, notFound } from './errors.js';
import mongoose from 'mongoose';
import { phoneKey, applyCallOutcome, rescore, salesTeam, CLOSED } from './sales.js';
import { note } from './notify.js';
import { sheetsConfigured, upsertAiCall, aiCallRow } from './sheets.js';

/*
 * Bridge between the CRM and the AI voice worker (voice/worker). The worker reports calls to
 * /api/ai/webhook; the CRM asks the worker to dial (/api/call) and to stream recordings (/api/recording).
 * Both directions use one shared secret: AI_WEBHOOK_SECRET here, CRM_WEBHOOK_SECRET on the worker.
 */

/** Calls this user may see: managers all; agents the ones they started or on leads assigned to them. */
export async function aiCallScope(ctx) {
  if (ctx.sales === 'MANAGER') return {};
  const mine = await M.Lead.find({ assignedTo: ctx.user._id }).distinct('_id');
  return { $or: [{ requestedBy: ctx.user._id }, { lead: { $in: mine } }] };
}

/** The AiCall in ctx.params.id, or 404 when it doesn't exist or isn't visible to this user. */
export async function loadAiCall(ctx) {
  const id = ctx.params.id;
  if (!mongoose.isValidObjectId(id)) throw bad('Invalid call');
  const call = await M.AiCall.findOne({ _id: id, ...(await aiCallScope(ctx)) });
  if (!call) throw notFound('Call not found');
  return call;
}

export const aiConfigured = () => !!(process.env.VOICE_API_URL && process.env.AI_WEBHOOK_SECRET);

/** Throws 401 unless the request carries the shared secret as a Bearer token. */
export function requireVoiceWorker(req) {
  const secret = process.env.AI_WEBHOOK_SECRET;
  if (!secret) throw new HttpError(503, 'AI_WEBHOOK_SECRET is not set');
  const given = (req.headers.get('authorization') || '').replace(/^Bearer /, '');
  const a = Buffer.from(given), b = Buffer.from(secret);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) throw new HttpError(401, 'Unauthorized');
}

function voiceFetch(path, init = {}) {
  if (!aiConfigured()) throw new HttpError(503, 'The AI calling agent is not connected (VOICE_API_URL / AI_WEBHOOK_SECRET)');
  return fetch(`${process.env.VOICE_API_URL.replace(/\/$/, '')}${path}`, {
    ...init,
    headers: { ...(init.headers || {}), authorization: `Bearer ${process.env.AI_WEBHOOK_SECRET}` },
  });
}

/** E.164 for an Indian mobile, or '' when the number can't be dialled by the agent. */
export function dialable(phone) {
  const k = phoneKey(phone);
  return /^[6-9]\d{9}$/.test(k) ? `+91${k}` : '';
}

const optedOut = (lead) => lead.status === 'NOT_INTERESTED' && /asked not to be called/i.test(lead.notes || '');

/** Ask the voice worker to dial; returns the carrier call id. */
async function requestDial(lead, to, purpose, requestedBy) {
  const res = await voiceFetch('/api/call', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ to, lead: { id: String(lead._id), name: lead.name, purpose: purpose || '' }, requestedBy: requestedBy ? String(requestedBy) : undefined }),
    signal: AbortSignal.timeout(20000),
  });
  const out = await res.json().catch(() => ({}));
  if (!res.ok || !out.callId) throw new HttpError(502, `The calling agent could not dial: ${out.error || `HTTP ${res.status}`}`);
  return out.callId;
}

/** "AI call" on one lead: dial now, outside the call list. Returns the AiCall. */
export async function startAiCall(ctx, lead, { purpose = '' } = {}) {
  const to = dialable(lead.phone);
  if (!to) throw bad('This lead has no Indian mobile number the agent can call');
  if (optedOut(lead)) throw bad('This person asked not to be called');
  // One AI call per lead at a time (also protects against double clicks).
  const busy = await M.AiCall.findOne({ lead: lead._id, status: { $in: ['QUEUED', 'IN_PROGRESS'] }, updatedAt: { $gt: new Date(Date.now() - STUCK_MS) } });
  if (busy) throw new HttpError(409, 'An AI call to this lead is already in progress');
  const callId = await requestDial(lead, to, purpose, ctx.user._id);
  return M.AiCall.findOneAndUpdate(
    { callId },
    { $setOnInsert: { callId, direction: 'outbound', status: 'QUEUED', phone: to, phoneKey: phoneKey(to), lead: lead._id, requestedBy: ctx.user._id, purpose: String(purpose).slice(0, 300), startedAt: new Date() } },
    { upsert: true, new: true },
  );
}

// ---- Call list: leads queued for the agent, dialled one after another ----

const STUCK_MS = 15 * 60000; // a call with no news for this long no longer blocks the next one
const MAX_ACTIVE = () => Math.max(1, Number(process.env.AI_MAX_CONCURRENT) || 1);
const QUEUE_LIMIT = 200;

/**
 * Calls may start inside AI_CALL_WINDOW, India time ("HH:MM-HH:MM", default 09:00-20:30:
 * TRAI allows 9:00-21:00, and 30 minutes are kept for the call itself).
 */
export function inCallingHours(now = new Date()) {
  const w = /^(\d\d):(\d\d)-(\d\d):(\d\d)$/.exec(process.env.AI_CALL_WINDOW || '') || [null, '09', '00', '20', '30'];
  const from = Number(w[1]) * 60 + Number(w[2]), to = Number(w[3]) * 60 + Number(w[4]);
  const ist = new Date(now.getTime() + 330 * 60000);
  const m = ist.getUTCHours() * 60 + ist.getUTCMinutes();
  return m >= from && m <= to;
}

/** Why a lead can't go on the call list, or '' when it can. */
function skipReason(lead) {
  if (!dialable(lead.phone)) return 'no Indian mobile number';
  if (optedOut(lead)) return 'asked not to be called';
  if (CLOSED.includes(lead.status)) return `lead is ${lead.status.toLowerCase().replace('_', ' ')}`;
  return '';
}

/** Put leads on the AI call list. Agents can only queue leads assigned to them. Returns { queued, skipped }. */
export async function queueAiCalls(ctx, leadIds, { purpose = '' } = {}) {
  const ids = [...new Set((leadIds || []).map(String))].filter((id) => mongoose.isValidObjectId(id));
  if (!ids.length) throw bad('Choose at least one lead');
  if (ids.length > QUEUE_LIMIT) throw bad(`At most ${QUEUE_LIMIT} leads at a time`);
  const scope = ctx.sales === 'MANAGER' ? {} : { assignedTo: ctx.user._id };
  const leads = await M.Lead.find({ _id: { $in: ids }, ...scope }).lean();
  const busy = new Set((await M.AiCall.find({ lead: { $in: leads.map((l) => l._id) }, status: { $in: ['SCHEDULED', 'QUEUED', 'IN_PROGRESS'] } }).distinct('lead')).map(String));
  const skipped = [], docs = [];
  for (const l of leads) {
    const why = busy.has(String(l._id)) ? 'already on the call list' : skipReason(l);
    if (why) { skipped.push({ name: l.name, reason: why }); continue; }
    const to = dialable(l.phone);
    docs.push({ callId: `list-${new mongoose.Types.ObjectId()}`, direction: 'outbound', status: 'SCHEDULED', phone: to, phoneKey: phoneKey(to),
      lead: l._id, requestedBy: ctx.user._id, purpose: String(purpose).slice(0, 300) });
  }
  if (ids.length > leads.length) skipped.push({ name: `${ids.length - leads.length} lead(s)`, reason: 'not found or not yours' });
  if (docs.length) {
    await M.AiCall.insertMany(docs);
    defer(() => dialNext().catch((e) => console.error('AI dialer:', e.message)));
  }
  return { queued: docs.length, skipped };
}

/** Take waiting calls off the list. Managers clear everyone's, agents their own. */
export async function cancelQueued(ctx) {
  const f = { status: 'SCHEDULED', ...(ctx.sales === 'MANAGER' ? {} : { requestedBy: ctx.user._id }) };
  const r = await M.AiCall.updateMany(f, { $set: { status: 'CANCELLED', hangupCause: `Removed from the list by ${ctx.user.name}` } });
  return { cancelled: r.modifiedCount };
}

/**
 * Dial the next call on the list if a line is free and it's calling hours. Safe to call any time and from
 * anywhere (after a call ends, after queueing, from the cron): each list entry is claimed atomically.
 */
export async function dialNext() {
  if (!aiConfigured()) return { dialled: 0, reason: 'not connected' };
  if (!inCallingHours()) return { dialled: 0, reason: 'outside calling hours' };
  let dialled = 0;
  for (let tries = 0; tries < 5; tries++) {
    const active = await M.AiCall.countDocuments({ status: { $in: ['QUEUED', 'IN_PROGRESS'] }, updatedAt: { $gt: new Date(Date.now() - STUCK_MS) } });
    if (active >= MAX_ACTIVE()) break;
    const next = await M.AiCall.findOneAndUpdate({ status: 'SCHEDULED' }, { $set: { status: 'QUEUED' } }, { sort: { createdAt: 1 }, new: true });
    if (!next) break;
    const lead = next.lead ? await M.Lead.findById(next.lead).lean() : null;
    const why = !lead ? 'lead was deleted' : skipReason(lead);
    if (why) { await M.AiCall.updateOne({ _id: next._id }, { $set: { status: 'CANCELLED', hangupCause: `Skipped: ${why}` } }); continue; }
    try {
      const callId = await requestDial(lead, next.phone, next.purpose, next.requestedBy);
      // The worker may already have reported this call (a fast failure): keep that record and drop the placeholder.
      const reported = await M.AiCall.findOne({ callId });
      if (reported) {
        await M.AiCall.updateOne({ _id: reported._id }, { $set: { lead: lead._id, requestedBy: next.requestedBy, purpose: next.purpose } });
        await M.AiCall.deleteOne({ _id: next._id });
      } else await M.AiCall.updateOne({ _id: next._id }, { $set: { callId, startedAt: new Date() } });
      dialled++;
    } catch (e) {
      await M.AiCall.updateOne({ _id: next._id }, { $set: { status: 'FAILED', outcome: 'FAILED', hangupCause: String(e.message).slice(0, 200), endedAt: new Date() } });
    }
  }
  return { dialled };
}

/** What the call list looks like now (for the AI Portal). */
export async function queueStatus(ctx) {
  const mine = ctx.sales === 'MANAGER' ? {} : { requestedBy: ctx.user._id };
  const [scheduled, active, next] = await Promise.all([
    M.AiCall.countDocuments({ ...mine, status: 'SCHEDULED' }),
    M.AiCall.findOne({ ...mine, status: { $in: ['QUEUED', 'IN_PROGRESS'] }, updatedAt: { $gt: new Date(Date.now() - STUCK_MS) } }).populate('lead', 'name').lean(),
    M.AiCall.find({ ...mine, status: 'SCHEDULED' }).sort({ createdAt: 1 }).limit(5).populate('lead', 'name').lean(),
  ]);
  return {
    scheduled, callingHours: inCallingHours(),
    active: active && { _id: active._id, status: active.status, name: active.lead?.name, phone: active.phone },
    next: next.map((c) => ({ _id: c._id, name: c.lead?.name, phone: c.phone })),
  };
}

/** Stream a call's recording from the voice worker (which holds the carrier credentials). */
export const fetchRecording = (callId, range) => voiceFetch(`/api/recording?call=${encodeURIComponent(callId)}`, { headers: range ? { range } : {} });

const OUTCOME_TO_CALL = { CALLBACK: 'CALL_BACK', INTERESTED: 'CONNECTED', INFO_GIVEN: 'CONNECTED', NOT_INTERESTED: 'CONNECTED', OPT_OUT: 'CONNECTED', NO_CONVERSATION: 'NO_ANSWER', FAILED: 'NO_ANSWER' };
const date = (v) => { const d = v ? new Date(v) : null; return d && !Number.isNaN(d.getTime()) ? d : undefined; };
const text = (v, n) => (v == null ? undefined : String(v).trim().slice(0, n) || undefined);

/**
 * Apply one event from the voice worker. Events for a call can arrive in any order and more than once:
 * every field is an upsert, and the lead is only updated the first time the call is reported finished.
 */
export async function ingestAiEvent(ev) {
  const callId = text(ev.callId, 80);
  if (!callId || !/^[\w-]+$/.test(callId)) throw bad('callId is required');
  const set = {};
  if (ev.direction && ['outbound', 'inbound', 'web'].includes(ev.direction)) set.direction = ev.direction;
  if (ev.phone) { set.phone = text(ev.phone, 30); set.phoneKey = phoneKey(ev.phone); }
  if (ev.event === 'call.started') { set.status = 'IN_PROGRESS'; set.startedAt = date(ev.startedAt) || new Date(); }
  if (ev.event === 'call.failed') { set.status = 'FAILED'; set.hangupCause = text(ev.hangupCause, 80); set.outcome = 'FAILED'; set.endedAt = date(ev.endedAt) || new Date(); }
  if (ev.event === 'call.ended') {
    const x = ev.extract || {};
    Object.assign(set, {
      status: 'COMPLETED', startedAt: date(ev.startedAt), endedAt: date(ev.endedAt) || new Date(),
      durationSec: Number.isFinite(ev.durationSec) ? Math.round(ev.durationSec) : undefined, hangupCause: text(ev.hangupCause, 80),
      transcript: Array.isArray(ev.transcript) ? ev.transcript.filter((m) => ['user', 'assistant'].includes(m?.role)).slice(0, 200).map((m) => ({ role: m.role, content: String(m.content || '').slice(0, 2000) })) : undefined,
      summary: text(x.summary, 1000), callerName: text(x.name, 120), company: text(x.company, 160), requirement: text(x.requirement, 500),
      outcome: ['CALLBACK', 'INTERESTED', 'INFO_GIVEN', 'NOT_INTERESTED', 'OPT_OUT', 'NO_CONVERSATION'].includes(x.outcome) ? x.outcome : undefined,
      interest: ['HOT', 'WARM', 'COLD', 'NOT_INTERESTED'].includes(x.interest) ? x.interest : undefined,
      callbackRequested: !!x.callbackRequested, callbackAt: date(x.callbackAt), callbackNote: text(x.callbackNote, 300), optOut: !!x.optOut,
    });
  }
  if (ev.event === 'call.recording' && ev.recording) {
    set.recordingId = text(ev.recording.id, 80);
    set.recordingUrl = text(ev.recording.url, 500);
    set.recordingDurationSec = Number(ev.recording.durationSec) || undefined;
  }
  for (const k of Object.keys(set)) if (set[k] === undefined) delete set[k];
  const insert = { callId };
  if (ev.leadId && /^[a-f\d]{24}$/i.test(ev.leadId)) insert.lead = ev.leadId;
  if (ev.requestedBy && /^[a-f\d]{24}$/i.test(ev.requestedBy)) insert.requestedBy = ev.requestedBy;
  if (ev.purpose) insert.purpose = text(ev.purpose, 300);
  for (const k of Object.keys(insert)) if (k in set) delete insert[k];
  const call = await M.AiCall.findOneAndUpdate({ callId }, { $set: set, $setOnInsert: insert }, { upsert: true, new: true });

  // Only the first "ended" touches the lead (the flag is claimed atomically, so a retried webhook does nothing).
  if (ev.event === 'call.ended' || ev.event === 'call.failed') {
    const claimed = await M.AiCall.findOneAndUpdate({ _id: call._id, appliedToLead: { $ne: true } }, { $set: { appliedToLead: true } }, { new: true });
    if (claimed) await applyToLead(claimed);
    defer(() => dialNext().catch((e) => console.error('AI dialer:', e.message)));
  }
  queueAiCallSync(call._id);
  return call;
}

async function applyToLead(call) {
  const spoke = (call.transcript || []).some((m) => m.role === 'user');
  let lead = call.lead ? await M.Lead.findById(call.lead) : null;
  if (!lead && call.phoneKey) lead = await M.Lead.findOne({ phoneKey: call.phoneKey }).sort({ updatedAt: -1 });
  if (!lead) {
    if (!spoke || !call.phoneKey) return; // nothing worth a lead
    lead = new (M.Lead)({
      name: (call.company || call.callerName || `AI caller ${call.phone}`).slice(0, 200), phone: call.phone, phoneKey: call.phoneKey,
      source: 'AI_CALL', notes: call.requirement, firstFoundAt: new Date(), lastFoundAt: new Date(),
    });
    rescore(lead);
    await lead.save();
    await M.LeadActivity.create({ lead: lead._id, type: 'CREATED', note: `Created by the AI agent from a ${call.direction} call` });
  }
  if (!lead.notes && call.requirement) lead.notes = call.requirement;

  const act = { lead: lead._id, type: 'AI_CALL', aiCall: call._id, phone: call.phone, durationSec: call.durationSec, endedAt: call.endedAt, by: call.requestedBy,
    note: [call.summary, call.callerName && `Name: ${call.callerName}`, call.requirement && `Needs: ${call.requirement}`].filter(Boolean).join(' · ').slice(0, 2000) };
  let status;
  if (call.optOut) { status = 'NOT_INTERESTED'; lead.notes = [lead.notes, 'Asked not to be called (AI call).'].filter(Boolean).join('\n').slice(0, 2000); }
  else if (call.outcome === 'NOT_INTERESTED') status = 'NOT_INTERESTED';
  else if (call.interest === 'HOT' || call.outcome === 'INTERESTED') status = CLOSED.includes(lead.status) ? undefined : 'INTERESTED';
  const followUpAt = call.callbackRequested && !call.optOut ? (call.callbackAt && call.callbackAt > new Date() ? call.callbackAt : new Date(Date.now() + 2 * 3600000)) : undefined;
  lead.callCount = (lead.callCount || 0) + 1;
  lead.lastCallAt = call.endedAt || new Date();
  applyCallOutcome(lead, act, { outcome: OUTCOME_TO_CALL[call.outcome] || (spoke ? 'CONNECTED' : 'NO_ANSWER'), followUpAt, status });
  await lead.save();
  await M.LeadActivity.create(act);
  if (!call.lead) await M.AiCall.updateOne({ _id: call._id }, { $set: { lead: lead._id } });

  if (followUpAt || status === 'INTERESTED') {
    // Tell whoever owns the lead, or every sales manager when nobody does.
    const to = lead.assignedTo ? [lead.assignedTo] : (await salesTeam()).filter((u) => u.sales === 'MANAGER').map((u) => u._id);
    const needs = call.requirement ? ` Needs: ${call.requirement}` : '';
    if (followUpAt) {
      const at = followUpAt.toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' });
      note(to, { title: 'Callback requested on an AI call', body: `${lead.name} (${call.phone}) wants a call back around ${at}.${needs}`, link: `/sales/leads/${lead._id}` });
    } else note(to, { title: 'Interested lead from an AI call', body: `${lead.name} (${call.phone}) is interested.${needs}`, link: `/sales/leads/${lead._id}` });
  }
}

/** Mirror one AI call to the "AI Calls" sheet tab after the response is sent. */
export function queueAiCallSync(id) {
  const key = String(id);
  defer(async () => {
    try {
      const s = await getSettings();
      if (!sheetsConfigured(s)) return;
      const c = await M.AiCall.findById(key).populate('lead', 'name status').lean();
      if (!c) return;
      await upsertAiCall(s, aiCallRow(c, process.env.APP_URL || ''));
      await M.Setting.updateOne({ key: 'system' }, { $set: { lastSheetSync: new Date() }, $unset: { lastSheetError: '', lastSheetErrorAt: '' } });
    } catch (e) {
      console.error('Sheets AI call sync failed:', e.message);
      await M.Setting.updateOne({ key: 'system' }, { $set: { lastSheetError: String(e.message).slice(0, 400), lastSheetErrorAt: new Date() } }).catch(() => {});
    }
  });
}
