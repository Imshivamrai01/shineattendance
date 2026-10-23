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

// ---- Call types ("scripts"): what the agent says on a Sales / Interview invite / Feedback call ----

// Calls to employees from the people pages (lib/staffCalls.js): "you didn't come in today, why?"
const ATTENDANCE_SCRIPT = { name: 'Attendance check', kind: 'ATTENDANCE', opening: 'Namaste {name} ji! Main {company} ki HR team se bol rahi hoon. Aaj aap office nahi aaye, sab theek hai?',
  instructions: 'You are calling an employee of the company, not a customer, because they did not come to the office (see the reason for the call). Be polite and caring, never rude or accusing. Ask why they did not come, whether they told their manager or applied for leave, and when they will come back to the office. If they are unwell or have an emergency, wish them well. Never approve or refuse leave and never talk about salary or action against them: say HR or their manager will look into it. Do not pitch anything and do not transfer the call. Once you know the reason and the day they will be back, thank them and end the call.',
  collect: 'Why they did not come, whether they informed their manager or applied for leave, and the date they will be back in the office.' };

const DEFAULT_SCRIPTS = [
  { name: 'Sales', kind: 'SALES', opening: 'Namaste {name} ji! Main {company} se bol rahi hoon. Kya aapke paas do minute hain?',
    instructions: 'Introduce the company in one line. Ask what they need and explain how we can help, using only the company information. Offer a demo or a call back from the sales team.',
    collect: 'Their name, business, what they need, and a good time for the sales team to call.' },
  { name: 'Interview invite', kind: 'INTERVIEW', opening: 'Namaste {name} ji! Main {company} ki HR team se bol rahi hoon, aapki job application ke baare mein.',
    instructions: 'Tell them they are shortlisted for an interview and give the interview details from the call details (date, time, place or link). Ask if they can come. If not, ask which day and time suits them. Answer questions about the job only from the company information; otherwise say HR will confirm.',
    collect: 'Will they attend (yes or no), the confirmed date and time, and any question for HR.' },
  { name: 'Feedback', kind: 'FEEDBACK', opening: 'Namaste {name} ji! Main {company} se bol rahi hoon. Hamari service ke baare mein do minute ka feedback lena tha.',
    instructions: 'Thank them for being a customer. Ask how their experience was, ask for a rating from 1 to 5, and ask what we can improve. If they have a complaint, apologise and say the team will call back.',
    collect: 'Rating from 1 to 5, what they liked, what to improve, and any complaint that needs a call back.' },
  ATTENDANCE_SCRIPT,
];

/** Call types, oldest first. The three defaults are created the first time anyone looks. */
export async function aiScripts({ all = false } = {}) {
  if (!(await M.AiScript.countDocuments())) await M.AiScript.insertMany(DEFAULT_SCRIPTS);
  else if (!(await M.AiScript.exists({ kind: 'ATTENDANCE' }))) await M.AiScript.create(ATTENDANCE_SCRIPT); // added after the first three
  return M.AiScript.find(all ? {} : { active: true }).sort({ createdAt: 1 }).lean();
}

/** The chosen call type, or the first Sales one. */
export async function pickScript(id) {
  const s = id && mongoose.isValidObjectId(id) ? await M.AiScript.findById(id).lean() : null;
  if (s) return s;
  const list = await aiScripts();
  return list.find((x) => x.kind === 'SALES') || list[0] || null;
}

const scriptFields = (script) => (script ? { script: script._id, scriptName: script.name, kind: script.kind } : { kind: 'SALES' });

/** Ask the voice worker to dial; returns the carrier call id. `target` = { id (lead), name }. */
export async function requestDial(target, to, purpose, requestedBy, scriptId) {
  const [script, settings] = await Promise.all([scriptId ? M.AiScript.findById(scriptId).lean() : pickScript(), getSettings()]);
  const res = await voiceFetch('/api/call', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      to, requestedBy: requestedBy ? String(requestedBy) : undefined,
      lead: { id: target.id ? String(target.id) : undefined, name: target.name || '', purpose: purpose || '' },
      company: settings.aiCompanyInfo || '',
      voice: { provider: settings.aiVoiceProvider || 'auto', sarvamSpeaker: settings.aiSarvamSpeaker || '' },
      script: script && { name: script.name, kind: script.kind, opening: script.opening || '', instructions: script.instructions || '', collect: script.collect || '' },
    }),
    signal: AbortSignal.timeout(20000),
  });
  const out = await res.json().catch(() => ({}));
  if (!res.ok || !out.callId) throw new HttpError(502, `The calling agent could not dial: ${out.error || `HTTP ${res.status}`}`);
  return out.callId;
}

/** "AI call" on one lead: dial now, outside the call list. Returns the AiCall. */
export async function startAiCall(ctx, lead, { purpose = '', scriptId } = {}) {
  const to = dialable(lead.phone);
  if (!to) throw bad('This lead has no Indian mobile number the agent can call');
  if (optedOut(lead)) throw bad('This person asked not to be called');
  // One AI call per lead at a time (also protects against double clicks).
  const busy = await M.AiCall.findOne({ lead: lead._id, status: { $in: ['QUEUED', 'IN_PROGRESS'] }, updatedAt: { $gt: new Date(Date.now() - STUCK_MS) } });
  if (busy) throw new HttpError(409, 'An AI call to this lead is already in progress');
  const script = await pickScript(scriptId);
  const callId = await requestDial({ id: lead._id, name: lead.name }, to, purpose, ctx.user._id, script?._id);
  return M.AiCall.findOneAndUpdate(
    { callId },
    { $setOnInsert: { callId, direction: 'outbound', status: 'QUEUED', phone: to, phoneKey: phoneKey(to), lead: lead._id, requestedBy: ctx.user._id, purpose: String(purpose).slice(0, 300), startedAt: new Date(), ...scriptFields(script) } },
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
export async function queueAiCalls(ctx, leadIds, { purpose = '', scriptId } = {}) {
  const ids = [...new Set((leadIds || []).map(String))].filter((id) => mongoose.isValidObjectId(id));
  if (!ids.length) throw bad('Choose at least one lead');
  if (ids.length > QUEUE_LIMIT) throw bad(`At most ${QUEUE_LIMIT} leads at a time`);
  const scope = ctx.sales === 'MANAGER' ? {} : { assignedTo: ctx.user._id };
  const leads = await M.Lead.find({ _id: { $in: ids }, ...scope }).lean();
  const busy = new Set((await M.AiCall.find({ lead: { $in: leads.map((l) => l._id) }, status: { $in: ['SCHEDULED', 'QUEUED', 'IN_PROGRESS'] } }).distinct('lead')).map(String));
  const script = await pickScript(scriptId);
  const skipped = [], docs = [];
  for (const l of leads) {
    const why = busy.has(String(l._id)) ? 'already on the call list' : skipReason(l);
    if (why) { skipped.push({ name: l.name, reason: why }); continue; }
    const to = dialable(l.phone);
    docs.push({ callId: `list-${new mongoose.Types.ObjectId()}`, direction: 'outbound', status: 'SCHEDULED', phone: to, phoneKey: phoneKey(to),
      lead: l._id, requestedBy: ctx.user._id, purpose: String(purpose).slice(0, 300), ...scriptFields(script) });
  }
  if (ids.length > leads.length) skipped.push({ name: `${ids.length - leads.length} lead(s)`, reason: 'not found or not yours' });
  if (docs.length) {
    await M.AiCall.insertMany(docs);
    defer(() => dialNext().catch((e) => console.error('AI dialer:', e.message)));
  }
  return { queued: docs.length, skipped };
}

/**
 * CRM page: call people who are not sales leads (interview candidates, customers for feedback).
 * `contacts` = [{ name, phone }]. Numbers that asked not to be called before are skipped.
 */
export async function queueContacts(ctx, contacts, { purpose = '', scriptId } = {}) {
  const list = (contacts || []).slice(0, QUEUE_LIMIT + 1);
  if (!list.length) throw bad('Add at least one name and number');
  if (list.length > QUEUE_LIMIT) throw bad(`At most ${QUEUE_LIMIT} people at a time`);
  const script = await pickScript(scriptId);
  const keys = list.map((c) => phoneKey(c.phone));
  const [blocked, busy] = await Promise.all([
    M.AiCall.find({ phoneKey: { $in: keys }, optOut: true }).distinct('phoneKey'),
    M.AiCall.find({ phoneKey: { $in: keys }, status: { $in: ['SCHEDULED', 'QUEUED', 'IN_PROGRESS'] } }).distinct('phoneKey'),
  ]);
  const seen = new Set(), skipped = [], docs = [];
  for (const c of list) {
    const name = String(c.name || '').trim().slice(0, 120), to = dialable(c.phone), key = phoneKey(c.phone);
    const why = !to ? 'not an Indian mobile number' : seen.has(key) ? 'listed twice' : blocked.includes(key) ? 'asked not to be called' : busy.includes(key) ? 'already on the call list' : '';
    if (why) { skipped.push({ name: name || c.phone, reason: why }); continue; }
    seen.add(key);
    docs.push({ callId: `list-${new mongoose.Types.ObjectId()}`, direction: 'outbound', status: 'SCHEDULED', phone: to, phoneKey: key,
      contactName: name, requestedBy: ctx.user._id, purpose: String(purpose).slice(0, 300), ...scriptFields(script) });
  }
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
    // _id breaks ties: a whole list is inserted in the same millisecond, in the order it was chosen.
    const next = await M.AiCall.findOneAndUpdate({ status: 'SCHEDULED' }, { $set: { status: 'QUEUED' } }, { sort: { createdAt: 1, _id: 1 }, new: true });
    if (!next) break;
    const lead = next.lead ? await M.Lead.findById(next.lead).lean() : null;
    const why = next.lead ? (!lead ? 'lead was deleted' : skipReason(lead))
      : (await M.AiCall.exists({ phoneKey: next.phoneKey, optOut: true })) ? 'asked not to be called' : '';
    if (why) { await M.AiCall.updateOne({ _id: next._id }, { $set: { status: 'CANCELLED', hangupCause: `Skipped: ${why}` } }); continue; }
    try {
      const target = lead ? { id: lead._id, name: lead.name } : { name: next.contactName };
      const callId = await requestDial(target, next.phone, next.purpose, next.requestedBy, next.script);
      // The worker may already have reported this call (a fast failure): keep that record and drop the placeholder.
      const reported = await M.AiCall.findOne({ callId });
      if (reported) {
        await M.AiCall.updateOne({ _id: reported._id }, { $set: { lead: next.lead, contactName: next.contactName, requestedBy: next.requestedBy, purpose: next.purpose,
          script: next.script, scriptName: next.scriptName, kind: next.kind } });
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
    M.AiCall.find({ ...mine, status: 'SCHEDULED' }).sort({ createdAt: 1, _id: 1 }).limit(5).populate('lead', 'name').lean(),
  ]);
  return {
    scheduled, callingHours: inCallingHours(),
    active: active && { _id: active._id, status: active.status, name: active.lead?.name || active.contactName, phone: active.phone, type: active.scriptName },
    next: next.map((c) => ({ _id: c._id, name: c.lead?.name || c.contactName, phone: c.phone })),
  };
}

/** Stream a call's recording from the voice worker (which holds the carrier credentials). */
export const fetchRecording = (callId, range, part = '') => voiceFetch(`/api/recording?call=${encodeURIComponent(callId)}${part === 'transfer' ? '&part=transfer' : ''}`, { headers: range ? { range } : {} });

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
      accepted: typeof x.accepted === 'boolean' ? x.accepted : undefined, appointmentAt: date(x.appointmentAt),
      rating: Number.isInteger(x.rating) && x.rating >= 1 && x.rating <= 5 ? x.rating : undefined, feedback: text(x.feedback, 1000),
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

/** Interview / feedback calls: tell whoever started them; log on the lead if there is one, but never move the pipeline. */
async function reportNonSales(call) {
  if (call.kind === 'ATTENDANCE') return reportStaffCall(call);
  if (call.lead) {
    await M.LeadActivity.create({ lead: call.lead, type: 'AI_CALL', aiCall: call._id, phone: call.phone, durationSec: call.durationSec, endedAt: call.endedAt,
      by: call.requestedBy, outcome: (call.transcript || []).some((m) => m.role === 'user') ? 'CONNECTED' : 'NO_ANSWER',
      note: [`${call.scriptName || 'AI call'}:`, call.summary].filter(Boolean).join(' ').slice(0, 2000) });
  }
  if (!call.requestedBy || call.status === 'FAILED') return;
  const who = call.contactName || call.callerName || call.phone;
  const at = call.appointmentAt ? ` for ${call.appointmentAt.toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' })}` : '';
  const result = call.kind === 'INTERVIEW' ? (call.accepted === true ? `accepted the interview${at}` : call.accepted === false ? 'cannot attend' : 'did not confirm')
    : call.kind === 'FEEDBACK' ? (call.rating ? `rated ${call.rating}/5` : 'gave feedback') : 'finished the call';
  note([call.requestedBy], { title: `${call.scriptName || 'AI call'}: ${who} ${result}`, body: call.summary || '', link: `/sales?tab=ai&call=${call._id}` });
}

/** Attendance calls to employees: save what they said on the StaffCall and tell whoever asked. */
async function reportStaffCall(call) {
  const spoke = (call.transcript || []).some((m) => m.role === 'user');
  const back = call.appointmentAt ? ` Back on ${call.appointmentAt.toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', day: '2-digit', month: 'short' })}.` : '';
  const reason = spoke ? `${call.summary || call.requirement || ''}${back}`.trim().slice(0, 1000) : '';
  const status = call.status === 'FAILED' ? 'FAILED' : spoke ? 'COMPLETED' : 'NO_ANSWER';
  const sc = await M.StaffCall.findOneAndUpdate({ aiCall: call._id }, { $set: { status, reason, durationSec: call.durationSec } }, { new: true }).populate('employee', 'name');
  if (!sc) return;
  const who = sc.employee?.name || call.contactName || call.phone;
  note([sc.by], { title: status === 'COMPLETED' ? `AI call: ${who} answered` : `AI call: ${who} did not ${status === 'FAILED' ? 'get the call' : 'answer'}`,
    body: reason || call.hangupCause || '', link: `/users/${sc.employee?._id || sc.employee}` });
}

async function applyToLead(call) {
  if (call.kind && call.kind !== 'SALES') return reportNonSales(call);
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

// ---- Recordings: fetch from VoBiz when its "recording ready" callback never came ----

async function syncOne(callId, part = '') {
  try {
    const res = await voiceFetch('/api/recording/sync', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ callId, part }), signal: AbortSignal.timeout(25000) });
    const out = await res.json().catch(() => ({}));
    return out.found ? out : null;
  } catch (e) { console.error('recording sync', callId, part, e.message); return null; }
}

/** Make sure one AI call (and its transfer part) has its recording. Returns true when something was added. */
export async function ensureAiCallRecording(call) {
  if (!aiConfigured() || /^list-/.test(call.callId) || call.status !== 'COMPLETED') return false;
  let added = false;
  if (!call.recordingId) {
    const r = await syncOne(call.callId);
    if (r) { await M.AiCall.updateOne({ _id: call._id }, { $set: { recordingId: r.id, recordingDurationSec: r.durationSec } }); call.recordingId = r.id; added = true; }
  }
  if (call.transfer?.status === 'ENDED' && !call.transfer.recordingId) {
    const r = await syncOne(call.callId, 'transfer');
    if (r) { await M.AiCall.updateOne({ _id: call._id }, { $set: { 'transfer.recordingId': r.id, 'transfer.recordingDurationSec': r.durationSec } }); added = true; }
  }
  if (added) queueAiCallSync(call._id);
  return added;
}

/** Cron: recordings still missing on calls from the last week (AI calls, transfers, office-line calls). */
export async function syncMissingRecordings({ limit = 15 } = {}) {
  if (!aiConfigured()) return { synced: 0 };
  const week = new Date(Date.now() - 7 * 86400000), settled = new Date(Date.now() - 60000);
  const calls = await M.AiCall.find({ status: 'COMPLETED', createdAt: { $gt: week }, updatedAt: { $lt: settled }, callId: { $not: /^list-/ },
    $or: [{ recordingId: { $exists: false } }, { recordingId: null }, { 'transfer.status': 'ENDED', 'transfer.recordingId': { $exists: false } }] })
    .sort({ createdAt: -1 }).limit(limit).lean();
  let synced = 0;
  for (const c of calls) if (await ensureAiCallRecording(c)) synced++;
  const acts = await M.LeadActivity.find({ type: 'CALL', 'bridge.status': 'ENDED', 'bridge.recordingId': { $exists: false }, createdAt: { $gt: week }, updatedAt: { $lt: settled } }).limit(limit);
  for (const a of acts) {
    const r = await syncOne(a.bridge.callId, 'bridge');
    if (r) { a.bridge.recordingId = r.id; a.bridge.recordingDurationSec = r.durationSec; a.markModified('bridge'); await a.save(); synced++; }
  }
  // Office-line calls to employees (lib/staffCalls.js)
  const staff = await M.StaffCall.find({ 'bridge.status': 'ENDED', 'bridge.recordingId': { $exists: false }, createdAt: { $gt: week }, updatedAt: { $lt: settled } }).limit(limit);
  for (const a of staff) {
    const r = await syncOne(a.bridge.callId, 'bridge');
    if (r) { a.bridge.recordingId = r.id; a.bridge.recordingDurationSec = r.durationSec; a.markModified('bridge'); await a.save(); synced++; }
  }
  return { synced, checked: calls.length + acts.length + staff.length };
}

const PROVIDER_NAMES = { rumik: 'Rumik (voice)', sarvam: 'Sarvam (voice)', deepgram: 'Deepgram (listening)', groq: 'Groq (thinking)' };

/**
 * The voice worker says a provider stopped working mid-call (no balance, bad key). Tell Admin / COO in the app,
 * at most once an hour per provider, so a silent agent never goes unnoticed.
 */
export async function providerAlert(ev) {
  const provider = PROVIDER_NAMES[ev.provider] ? ev.provider : 'voice';
  const now = new Date(), key = `aiProviderAlertAt.${provider}`;
  const r = await M.Setting.updateOne({ key: 'system', $or: [{ [key]: { $exists: false } }, { [key]: { $lt: new Date(now - 3600000) } }] }, { $set: { [key]: now } });
  if (!r.modifiedCount) return { alerted: false };
  const admins = await M.User.find({ status: 'ACTIVE', role: { $in: ['ADMIN', 'COO'] } }).distinct('_id');
  const other = provider === 'rumik' ? ' The agent switches to Sarvam for the rest of the call if a Sarvam key is set.' : provider === 'sarvam' ? ' The agent switches to Rumik if its key works.' : '';
  note(admins, { title: `AI calls: ${PROVIDER_NAMES[provider] || provider} stopped working`, body: `${String(ev.message || '').slice(0, 200)}. Recharge or check the key.${other}`, link: '/sales?tab=ai' });
  return { alerted: true };
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
