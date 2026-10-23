import mongoose from 'mongoose';
import { M, getSettings } from './db.js';
import { HttpError, bad, notFound } from './errors.js';
import { applyCallOutcome, rescore, PENDING } from './sales.js';
import { aiConfigured, dialable } from './aiCalls.js';

/*
 * Office-line calls: pressing Call on a lead rings the sales person's own mobile first (from the company number);
 * when they pick up, the lead is dialled and both are connected. The voice worker (voice/worker/src/bridge.js)
 * records the call and reports bridge.status / bridge.recording / bridge.summary to /api/ai/webhook.
 * The call is an ordinary CALL activity on the lead, so the outcome popup, call log and follow-ups work as before.
 */

const LIVE = ['CALLING_AGENT', 'RINGING_LEAD', 'CONNECTED'];

/** Can this person call through the office line? { enabled, hasMobile, reason } */
export const callerPhone = (user) => dialable(user.callMobile) || dialable(user.mobile);

export async function officeLine(user) {
  const s = await getSettings();
  const mobile = callerPhone(user);
  if (s.officeLineEnabled === false) return { enabled: false, reason: 'Office-line calling is switched off' };
  if (!aiConfigured()) return { enabled: false, reason: 'The calling service is not connected' };
  if (!mobile) return { enabled: false, hasMobile: false, needsNumber: true, reason: 'Add the mobile number your office calls should ring' };
  return { enabled: true, hasMobile: true, mobile: `••••••${mobile.slice(-4)}` };
}

export function voiceFetch(path, body) {
  return fetch(`${process.env.VOICE_API_URL.replace(/\/$/, '')}${path}`, {
    method: 'POST', headers: { authorization: `Bearer ${process.env.AI_WEBHOOK_SECRET}`, 'content-type': 'application/json' },
    body: JSON.stringify(body), signal: AbortSignal.timeout(20000),
  });
}

/** The caller sets the number office-line calls ring first (their own phone). */
export async function setCallerPhone(user, phone) {
  const e164 = dialable(phone);
  if (!e164) throw bad('Enter a 10-digit Indian mobile number');
  await M.User.updateOne({ _id: user._id }, { $set: { callMobile: e164 } });
  return officeLine({ ...user, callMobile: e164 });
}

/** Start an office-line call to a lead. Records the CALL right away (as with the phone dialer), then rings the caller. */
export async function startOfficeCall(ctx, lead) {
  const line = await officeLine(ctx.user);
  if (!line.enabled) throw bad(line.reason);
  const to = dialable(lead.phone);
  if (!to) throw bad('This lead has no Indian mobile number to call through the office line');
  const busy = await M.LeadActivity.findOne({ by: ctx.user._id, type: 'CALL', 'bridge.status': { $in: LIVE }, createdAt: { $gt: new Date(Date.now() - 30 * 60000) } });
  if (busy) throw new HttpError(409, 'You are already on an office-line call. Hang it up first.');

  const now = new Date();
  lead.callCount = (lead.callCount || 0) + 1;
  lead.lastCallAt = now; lead.lastCallBy = ctx.user._id; lead.lastOutcome = PENDING; lead.lastActivityAt = now;
  rescore(lead);
  await lead.save();
  const act = await M.LeadActivity.create({ lead: lead._id, type: 'CALL', outcome: PENDING, viaApp: true, phone: to, by: ctx.user._id, bridge: { status: 'CALLING_AGENT' } });

  const res = await voiceFetch('/api/bridge', {
    activityId: String(act._id), agent: { id: String(ctx.user._id), name: ctx.user.name, phone: callerPhone(ctx.user) }, lead: { id: String(lead._id), name: lead.name, phone: to },
  }).catch((e) => ({ ok: false, json: async () => ({ error: e.message }) }));
  const out = await res.json().catch(() => ({}));
  if (!res.ok || !out.callId) {
    // Undo: no call happened.
    await M.LeadActivity.deleteOne({ _id: act._id });
    await M.Lead.updateOne({ _id: lead._id }, { $inc: { callCount: -1 } });
    throw new HttpError(502, `Could not start the office-line call: ${out.error || `HTTP ${res.status}`}`);
  }
  act.bridge.callId = out.callId;
  await act.save();
  return act;
}

/** A CALL activity this user may see / act on (own calls; sales managers all). */
export async function loadCall(ctx) {
  const id = ctx.params.id;
  if (!mongoose.isValidObjectId(id)) throw bad('Invalid call');
  const act = await M.LeadActivity.findOne({ _id: id, type: 'CALL', ...(ctx.sales === 'MANAGER' ? {} : { by: ctx.user._id }) });
  if (!act) throw notFound('Call not found');
  return act;
}

export async function hangupOfficeCall(act) {
  if (!act.bridge?.callId) throw bad('This call did not go through the office line');
  const res = await voiceFetch('/api/hangup', { callId: act.bridge.callId });
  return { ok: res.ok };
}

/** bridge.status / bridge.recording / bridge.summary from the voice worker. Safe to receive twice. */
export async function ingestBridgeEvent(ev) {
  const act = await M.LeadActivity.findOne({ 'bridge.callId': String(ev.callId || '') });
  if (!act) return null;
  const b = act.bridge;
  if (ev.event === 'bridge.status') {
    const s = ev.status, before = b.status;
    if (s === 'RINGING_LEAD' && before === 'CALLING_AGENT') b.status = s;
    else if (s === 'CONNECTED' && !['CONNECTED', 'ENDED'].includes(before)) { b.status = s; b.leadAnsweredAt = new Date(); }
    else if (s === 'ENDED' && before !== 'ENDED') {
      b.status = 'ENDED';
      b.talkSec = Math.round(Number(ev.talkSec) || 0);
      act.durationSec = b.talkSec;
    } else if (['NO_ANSWER', 'BUSY', 'FAILED'].includes(s) && !['CONNECTED', 'ENDED', 'NO_ANSWER', 'BUSY', 'FAILED'].includes(before)) {
      b.status = s; b.reason = String(ev.reason || '').slice(0, 120);
      // The lead didn't pick up: save the outcome for the caller (they can still change the follow-up later).
      if (act.outcome === PENDING) {
        const lead = await M.Lead.findById(act.lead);
        if (lead) {
          applyCallOutcome(lead, act, { outcome: s === 'BUSY' ? 'BUSY' : 'NO_ANSWER', followUpAt: null, status: null });
          act.endedAt = new Date();
          await lead.save();
        }
      }
    } else if (s === 'AGENT_NO_ANSWER' && before === 'CALLING_AGENT') {
      // The caller didn't pick up their own phone: the lead was never called, so this isn't a call on the lead.
      await M.Lead.updateOne({ _id: act.lead, callCount: { $gt: 0 } }, { $inc: { callCount: -1 } });
      b.status = 'AGENT_NO_ANSWER';
      act.outcome = 'CALL_CUT';
      act.note = 'Office-line call: you did not pick up, so the lead was not called.';
    }
  } else if (ev.event === 'bridge.recording' && ev.recording) {
    b.recordingId = String(ev.recording.id || 'recorded').slice(0, 80);
    b.recordingDurationSec = Number(ev.recording.durationSec) || undefined;
  } else if (ev.event === 'bridge.summary') {
    b.transcript = (Array.isArray(ev.transcript) ? ev.transcript : []).filter((m) => ['team', 'customer'].includes(m?.role)).slice(0, 300)
      .map((m) => ({ role: m.role, content: String(m.content || '').slice(0, 2000) }));
    b.summary = String(ev.summary || '').slice(0, 1500);
    if (!act.note && b.summary) act.note = b.summary.slice(0, 2000); // "What was said", unless the caller wrote it
  } else return act;
  act.markModified('bridge');
  await act.save();
  return act;
}

/** Stream an office-line call's recording from the voice worker. */
export const fetchOfficeRecording = (callId, range) => fetch(`${process.env.VOICE_API_URL.replace(/\/$/, '')}/api/recording?call=${encodeURIComponent(callId)}&part=bridge`, {
  headers: { authorization: `Bearer ${process.env.AI_WEBHOOK_SECRET}`, ...(range ? { range } : {}) },
});
