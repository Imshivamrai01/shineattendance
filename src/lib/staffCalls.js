import mongoose from 'mongoose';
import { M } from './db.js';
import { handler, HttpError, bad, forbidden, notFound } from './http.js';
import { dateKey } from './dates.js';
import { canManage, loadVisibleUser } from './users.js';
import { dialable, requestDial, aiScripts, aiConfigured, queueContacts } from './aiCalls.js';
import { officeLine, voiceFetch, callerPhone } from './officeCalls.js';

/*
 * Calls to employees, the same two ways as calls to sales leads:
 *  - AI call: the voice agent rings the employee with the "Attendance check" call type (asks why they didn't come in,
 *    whether they told anyone, when they'll be back); the summary comes back as the StaffCall's reason (aiCalls.js).
 *  - Office line: the caller's own phone rings first from the company number, then the employee; recorded and
 *    summarised by the voice worker (bridge.* events, ingestStaffBridgeEvent below).
 * Admin, COO, Managers and HR can call the people they manage.
 */

const LIVE = ['CALLING_AGENT', 'RINGING_LEAD', 'CONNECTED'];

/** Route wrapper: anyone who oversees people (not plain employees). */
export const staffHandler = (fn) => handler(fn, { roles: ['ADMIN', 'COO', 'MANAGER', 'HR'] });

/** The employee in ctx.params.id, if this person may call them. Returns { user, phone }. */
export async function loadCallee(ctx) {
  if (!mongoose.isValidObjectId(ctx.params.id)) throw bad('Invalid user');
  const u = await loadVisibleUser(ctx.user, ctx.params.id);
  if (String(u._id) === String(ctx.user._id) || !canManage(ctx.user, u)) throw forbidden();
  const phone = dialable(u.mobile) || dialable(u.callMobile);
  if (!phone) throw bad(`${u.name} has no Indian mobile number to call`);
  return { user: u, phone };
}

const purposeFor = (extra) => [`Did not come to the office on ${dateKey()} (today)`, extra].filter(Boolean).join('. ').slice(0, 300);

/** The voice agent rings the employee now. */
export async function startStaffAiCall(ctx, { purpose = '' } = {}) {
  if (!aiConfigured()) throw new HttpError(503, 'The AI calling agent is not connected');
  const { user, phone } = await loadCallee(ctx);
  const busy = await M.StaffCall.findOne({ employee: user._id, mode: 'AI', status: 'IN_PROGRESS', createdAt: { $gt: new Date(Date.now() - 15 * 60000) } });
  if (busy) throw new HttpError(409, `An AI call to ${user.name} is already in progress`);
  const script = (await aiScripts()).find((s) => s.kind === 'ATTENDANCE');
  if (!script) throw bad('The "Attendance check" call type is switched off. Turn it on under AI calls → Agent setup.');
  const why = purposeFor(String(purpose).trim());
  const callId = await requestDial({ name: user.name }, phone, why, ctx.user._id, script._id);
  // $set, not $setOnInsert: the worker may already have reported the call, and it must not be taken for a sales call.
  const call = await M.AiCall.findOneAndUpdate({ callId }, {
    $set: { employee: user._id, contactName: user.name, kind: 'ATTENDANCE', script: script._id, scriptName: script.name, requestedBy: ctx.user._id, purpose: why },
    $setOnInsert: { callId, direction: 'outbound', status: 'QUEUED', phone, startedAt: new Date() },
  }, { upsert: true, new: true });
  return M.StaffCall.create({ employee: user._id, by: ctx.user._id, date: dateKey(), mode: 'AI', phone, purpose: why, aiCall: call._id });
}

/** Office line: ring the caller's phone, then the employee. */
export async function startStaffOfficeCall(ctx) {
  const { user, phone } = await loadCallee(ctx);
  return startOfficeCall(ctx, { section: 'EMPLOYEE', employee: user._id, name: user.name, phone });
}

/**
 * Several employees at once from the CRM: each goes on the AI call list (one call at a time, calling hours only)
 * with the "Attendance check" call type. Returns { queued, skipped }.
 */
export async function queueStaffAiCalls(ctx, userIds, { purpose = '' } = {}) {
  if (!aiConfigured()) throw new HttpError(503, 'The AI calling agent is not connected');
  const script = (await aiScripts()).find((x) => x.kind === 'ATTENDANCE');
  if (!script) throw bad('The "Attendance check" call type is switched off. Turn it on under CRM → Settings → AI agent.');
  const ids = [...new Set((userIds || []).map(String))].filter((id) => mongoose.isValidObjectId(id)).slice(0, 200);
  const users = (await M.User.find({ _id: { $in: ids }, status: 'ACTIVE' })).filter((u) => String(u._id) !== String(ctx.user._id) && canManage(ctx.user, u));
  const skipped = users.length < ids.length ? [{ name: `${ids.length - users.length} person(s)`, reason: 'not someone you manage' }] : [];
  const why = purposeFor(String(purpose).trim());
  const contacts = users.map((u) => ({ name: u.name, phone: dialable(u.mobile) || dialable(u.callMobile) || u.mobile || '', employee: u._id }));
  if (!contacts.length) return { queued: 0, skipped };
  const r = await queueContacts(ctx, contacts, { purpose: why, scriptId: script._id, kind: 'ATTENDANCE' });
  await M.StaffCall.insertMany(r.calls.map((c) => ({ section: 'EMPLOYEE', employee: c.employee, by: ctx.user._id, date: dateKey(), mode: 'AI', phone: c.phone, purpose: why, aiCall: c._id })));
  return { queued: r.queued, skipped: [...skipped, ...r.skipped] };
}

/**
 * Office line to anyone: ring the caller's phone, then `target` = { section, name, phone, employee? , list?, contact? }.
 * Recorded and summarised; the StaffCall follows the call (ingestStaffBridgeEvent).
 */
export async function startOfficeCall(ctx, target) {
  const line = await officeLine(ctx.user);
  if (!line.enabled) throw bad(line.reason);
  const phone = dialable(target.phone);
  if (!phone) throw bad(`${target.name || 'This person'} has no Indian mobile number to call`);
  const recent = { createdAt: { $gt: new Date(Date.now() - 30 * 60000) } };
  const busy = (await M.StaffCall.exists({ by: ctx.user._id, 'bridge.status': { $in: LIVE }, ...recent }))
    || (await M.LeadActivity.exists({ by: ctx.user._id, type: 'CALL', 'bridge.status': { $in: LIVE }, ...recent }));
  if (busy) throw new HttpError(409, 'You are already on an office-line call. Hang it up first.');

  const sc = await M.StaffCall.create({ section: target.section, employee: target.employee, list: target.list, contact: target.contact, contactName: target.name,
    by: ctx.user._id, date: dateKey(), mode: 'OFFICE', phone, bridge: { status: 'CALLING_AGENT' } });
  const res = await voiceFetch('/api/bridge', {
    activityId: String(sc._id), agent: { id: String(ctx.user._id), name: ctx.user.name, phone: callerPhone(ctx.user) }, lead: { id: String(target.employee || target.contact || sc._id), name: target.name || '', phone },
  }).catch((e) => ({ ok: false, json: async () => ({ error: e.message }) }));
  const out = await res.json().catch(() => ({}));
  if (!res.ok || !out.callId) {
    await M.StaffCall.deleteOne({ _id: sc._id });
    throw new HttpError(502, `Could not start the office-line call: ${out.error || `HTTP ${res.status}`}`);
  }
  sc.bridge.callId = out.callId;
  await sc.save();
  return sc;
}

/**
 * A StaffCall this user may see: calls to anyone they oversee. `own`: only to change it (hang up, note what was said),
 * which is for whoever made the call, or Admin / COO.
 */
export async function loadStaffCall(ctx, { own = false } = {}) {
  if (!mongoose.isValidObjectId(ctx.params.id)) throw bad('Invalid call');
  const sc = await M.StaffCall.findById(ctx.params.id);
  const mine = sc && (String(sc.by) === String(ctx.user._id) || ['ADMIN', 'COO'].includes(ctx.user.role));
  const ok = sc && (mine || (!own && (await loadVisibleUser(ctx.user, sc.employee).then(() => true, () => false))));
  if (!ok) throw notFound('Call not found');
  return sc;
}

/** Calls to one employee, newest first, with the AI call's summary and transcript. */
export async function staffCallsFor(ctx, employeeId) {
  const list = await M.StaffCall.find({ employee: employeeId }).sort({ createdAt: -1 }).limit(30)
    .populate('by', 'name').populate('aiCall', 'status durationSec summary transcript recordingId hangupCause').lean();
  return list.map((c) => ({ ...c, mine: String(c.by?._id) === String(ctx.user._id) }));
}

/** bridge.status / bridge.recording / bridge.summary for an office-line call to an employee. Safe to receive twice. */
export async function ingestStaffBridgeEvent(ev) {
  const sc = await M.StaffCall.findOne({ 'bridge.callId': String(ev.callId || '') });
  if (!sc) return null;
  const b = sc.bridge;
  if (ev.event === 'bridge.status') {
    const s = ev.status, before = b.status;
    if (s === 'RINGING_LEAD' && before === 'CALLING_AGENT') b.status = s;
    else if (s === 'CONNECTED' && !['CONNECTED', 'ENDED'].includes(before)) { b.status = s; b.leadAnsweredAt = new Date(); }
    else if (s === 'ENDED' && before !== 'ENDED') {
      b.status = 'ENDED'; b.talkSec = Math.round(Number(ev.talkSec) || 0);
      sc.durationSec = b.talkSec; sc.status = 'COMPLETED';
    } else if (['NO_ANSWER', 'BUSY', 'FAILED'].includes(s) && !['CONNECTED', 'ENDED', 'NO_ANSWER', 'BUSY', 'FAILED'].includes(before)) {
      b.status = s; b.reason = String(ev.reason || '').slice(0, 120);
      sc.status = s === 'FAILED' ? 'FAILED' : 'NO_ANSWER';
    } else if (s === 'AGENT_NO_ANSWER' && before === 'CALLING_AGENT') {
      b.status = 'AGENT_NO_ANSWER'; sc.status = 'FAILED';
      sc.note = sc.note || 'You did not pick up, so the employee was not called.';
    }
  } else if (ev.event === 'bridge.recording' && ev.recording) {
    b.recordingId = String(ev.recording.id || 'recorded').slice(0, 80);
    b.recordingDurationSec = Number(ev.recording.durationSec) || undefined;
  } else if (ev.event === 'bridge.summary') {
    b.transcript = (Array.isArray(ev.transcript) ? ev.transcript : []).filter((m) => ['team', 'customer'].includes(m?.role)).slice(0, 300)
      .map((m) => ({ role: m.role, content: String(m.content || '').slice(0, 2000) }));
    b.summary = String(ev.summary || '').slice(0, 1500);
    if (!sc.reason && b.summary) sc.reason = b.summary.slice(0, 1000);
  } else return sc;
  sc.markModified('bridge');
  await sc.save();
  if (sc.list && sc.contact) await syncContact(sc);
  return sc;
}

/** An office-line call to someone on a CRM list moves them on the list: called / no answer, and what they said. */
export async function syncContact(sc) {
  const set = { 'contacts.$.lastCallAt': sc.createdAt };
  const c = (await M.ContactList.findOne({ _id: sc.list, 'contacts._id': sc.contact }, { 'contacts.$': 1 }).lean())?.contacts?.[0];
  if (!c) return;
  if (['NO_ANSWER', 'FAILED'].includes(sc.status) && sc.bridge?.status !== 'AGENT_NO_ANSWER' && ['NEW', 'NO_ANSWER'].includes(c.status)) set['contacts.$.status'] = 'NO_ANSWER';
  if (sc.status === 'COMPLETED' && ['NEW', 'NO_ANSWER'].includes(c.status)) set['contacts.$.status'] = 'CALLED';
  if (sc.reason) set['contacts.$.note'] = sc.reason;
  await M.ContactList.updateOne({ _id: sc.list, 'contacts._id': sc.contact }, { $set: set });
}
