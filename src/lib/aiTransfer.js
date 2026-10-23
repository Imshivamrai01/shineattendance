import { M, getSettings } from './db.js';
import { dateKey } from './dates.js';
import { CLOSED, rescore, salesTeam } from './sales.js';
import { note } from './notify.js';
import { dialable, queueAiCallSync } from './aiCalls.js';

/*
 * Live transfer: during an AI call the caller asks for a person. The voice worker asks /api/ai/transfer who to ring,
 * VoBiz rings them (with the AI's summary as a whisper), and the worker reports call.transfer events back here.
 */

const BUSY_MS = 30 * 60000; // a transfer with no news for this long no longer marks its person busy
const who = (call) => call.contactName || call.callerName || call.lead?.name || call.phone;

/** People the AI may put this caller through to, best first. Marks the call as asking for a transfer. */
export async function transferTargets(callId) {
  const s = await getSettings();
  const call = await M.AiCall.findOne({ callId }).populate('lead', 'name assignedTo');
  const base = { mode: s.aiTransferMode || 'SEQUENTIAL', ringSec: Math.min(45, Math.max(10, s.aiTransferRingSec || 20)) };
  if (s.aiTransferEnabled === false) return { ...base, enabled: false, targets: [], reason: 'Live transfer is switched off' };

  let people = (await M.User.find({ status: 'ACTIVE', aiTransfer: true }).select('name mobile').lean()).filter((u) => dialable(u.mobile));
  const ids = people.map((u) => u._id);
  if (s.aiTransferNeedCheckIn !== false && people.length) {
    // Only people in the office right now: checked in today and not checked out.
    const att = await M.Attendance.find({ date: dateKey(), status: 'ACTIVE', user: { $in: ids } }).select('user sessions').lean();
    const here = new Set(att.filter((a) => (a.sessions || []).some((x) => x.checkIn && !x.checkOut)).map((a) => String(a.user)));
    people = people.filter((u) => here.has(String(u._id)));
  }
  // Busy: being rung for, or talking to, another caller.
  const live = await M.AiCall.find({ 'transfer.status': { $in: ['RINGING', 'CONNECTED'] }, $or: [{ 'transfer.to': { $in: ids } }, { 'transfer.ringing': { $in: ids } }],
    updatedAt: { $gt: new Date(Date.now() - BUSY_MS) }, callId: { $ne: callId } }).select('transfer.status transfer.to transfer.ringing').lean();
  const busy = new Set(live.flatMap((c) => (c.transfer.status === 'CONNECTED' ? [c.transfer.to] : c.transfer.ringing || [])).filter(Boolean).map(String));
  people = people.filter((u) => !busy.has(String(u._id)));

  // The lead's owner first, then whoever has taken the fewest transfers today.
  const today = new Date(`${dateKey()}T00:00:00+05:30`);
  const counts = Object.fromEntries((await M.AiCall.aggregate([
    { $match: { 'transfer.to': { $in: people.map((u) => u._id) }, 'transfer.answeredAt': { $gte: today } } },
    { $group: { _id: '$transfer.to', n: { $sum: 1 } } }])).map((x) => [String(x._id), x.n]));
  const owner = String(call?.lead?.assignedTo || '');
  people.sort((a, b) => (String(b._id) === owner) - (String(a._id) === owner) || (counts[a._id] || 0) - (counts[b._id] || 0));

  if (call) {
    call.transfer = { ...(call.toObject().transfer || {}), status: 'REQUESTED', requestedAt: new Date(), tried: [] };
    await call.save();
  }
  return { ...base, enabled: true, who: call ? who(call) : '', targets: people.slice(0, 5).map((u) => ({ id: String(u._id), name: u.name, phone: dialable(u.mobile) })) };
}

/** When nobody took the transfer: a sensible time for the team to call back (in an hour, or 10:30 next morning). */
function callbackTime(now = new Date()) {
  const inHour = new Date(now.getTime() + 3600000);
  const istHour = new Date(inHour.getTime() + 330 * 60000).getUTCHours();
  if (istHour >= 10 && istHour < 19) return inHour;
  const next = new Date(`${dateKey(new Date(now.getTime() + (istHour >= 19 ? 86400000 : 0)))}T10:30:00+05:30`);
  return next > now ? next : new Date(next.getTime() + 86400000);
}

const fmt = (d) => d.toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' });

/** call.transfer / call.transfer.recording / call.transfer.summary from the voice worker. Safe to receive twice. */
export async function ingestTransferEvent(ev) {
  const call = await M.AiCall.findOne({ callId: String(ev.callId || '') }).populate('lead', 'name assignedTo');
  if (!call) return null;
  const t = { ...(call.toObject().transfer || {}) };
  const before = t.status;
  const link = `/crm?section=sales&tab=ai&call=${call._id}`;

  if (ev.event === 'call.transfer') {
    const toId = /^[a-f\d]{24}$/i.test(ev.toUserId || '') ? ev.toUserId : null;
    if (ev.status === 'RINGING') {
      // One by one: only the person ringing now is busy. Everyone at once: all of them.
      // ev.next = the previous person stopped ringing (one-by-one mode moved on)
      t.ringing = toId ? [...(before === 'RINGING' && t.ringing && !ev.next ? t.ringing.map(String) : []), toId] : t.ringing || [];
      t.status = 'RINGING';
      if (ev.toName) t.tried = [...new Set([...(t.tried || []), ev.toName])];
      if (toId) note([toId], { title: `Incoming AI transfer: ${who(call)}`, body: (ev.whisper || call.summary || 'A caller asked for a person.').slice(0, 300), link });
    } else if (ev.status === 'CONNECTED' && !['CONNECTED', 'ENDED'].includes(before)) {
      Object.assign(t, { status: 'CONNECTED', to: toId || t.to, toName: ev.toName || t.toName, answeredAt: new Date(), ringing: [] });
    } else if (ev.status === 'ENDED' && before !== 'ENDED') {
      Object.assign(t, { status: 'ENDED', endedAt: new Date(), durationSec: Number(ev.durationSec) || t.durationSec });
      if (call.lead && t.to) {
        // Counts as that person's call on the lead (and in their call log).
        await M.LeadActivity.create({ lead: call.lead._id, type: 'CALL', outcome: 'CONNECTED', by: t.to, phone: call.phone, durationSec: t.durationSec, endedAt: t.endedAt,
          aiCall: call._id, note: 'Took a live transfer from the AI call' });
        await M.Lead.updateOne({ _id: call.lead._id }, { $inc: { callCount: 1, connectedCount: 1 }, $set: { lastCallAt: t.endedAt, lastCallBy: t.to, lastOutcome: 'CONNECTED', lastActivityAt: t.endedAt } });
      }
    } else if (['NO_ANSWER', 'FAILED'].includes(ev.status) && !['CONNECTED', 'ENDED', 'NO_ANSWER', 'FAILED'].includes(before)) {
      Object.assign(t, { status: ev.status, reason: String(ev.reason || '').slice(0, 200), endedAt: new Date() });
      // Nobody took it: it becomes a callback for the team.
      const at = callbackTime();
      Object.assign(call, { callbackRequested: true, callbackAt: call.callbackAt || at, callbackNote: `Asked for a person; live transfer ${ev.status === 'FAILED' ? 'failed' : 'not answered'}.`, handledAt: undefined });
      if (call.lead) {
        const lead = await M.Lead.findById(call.lead._id);
        if (lead && !CLOSED.includes(lead.status)) {
          if (!lead.nextFollowUpAt || lead.nextFollowUpAt > at) lead.nextFollowUpAt = at;
          if (['NEW', 'CONTACTED'].includes(lead.status)) lead.status = 'FOLLOW_UP';
          rescore(lead);
          await lead.save();
          await M.LeadActivity.create({ lead: lead._id, type: 'FOLLOW_UP', followUpAt: at, aiCall: call._id, note: 'Caller asked for a person on the AI call; nobody picked up the transfer.' });
        }
      }
      const to = call.lead?.assignedTo ? [call.lead.assignedTo] : (await salesTeam()).filter((u) => u.sales === 'MANAGER').map((u) => u._id);
      note(to, { title: `Missed live transfer: ${who(call)}`, body: `${call.phone} asked to talk to someone and nobody picked up. Call back around ${fmt(at)}.`, link });
    }
  } else if (ev.event === 'call.transfer.recording' && ev.recording) {
    Object.assign(t, { recordingId: String(ev.recording.id || 'recorded').slice(0, 80), recordingDurationSec: Number(ev.recording.durationSec) || undefined });
  } else if (ev.event === 'call.transfer.summary') {
    t.transcript = (Array.isArray(ev.transcript) ? ev.transcript : []).filter((m) => ['team', 'customer'].includes(m?.role)).slice(0, 300)
      .map((m) => ({ role: m.role, content: String(m.content || '').slice(0, 2000) }));
    t.summary = String(ev.summary || '').slice(0, 1500);
    if (t.summary) await M.LeadActivity.updateOne({ aiCall: call._id, type: 'CALL' }, { $set: { note: `Live transfer: ${t.summary}`.slice(0, 2000) } });
  } else return call;

  call.transfer = t;
  await call.save();
  queueAiCallSync(call._id);
  return call;
}
