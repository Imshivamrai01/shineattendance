// Tests live transfer without placing calls: who gets rung (CRM) and how transfer events update the call and lead,
// plus the VoBiz XML the voice worker returns. Needs MONGODB_URI pointing at a TEST database (never production):
//   MONGODB_URI=<staging uri> node scripts/ai-transfer-test.mjs
import { register } from 'node:module';
import mongoose from 'mongoose';

if (!/staging|test/i.test(process.env.MONGODB_URI || '')) { console.error('Refusing: MONGODB_URI must be a staging/test database'); process.exit(1); }
register(`data:text/javascript,${encodeURIComponent(`
  const src = ${JSON.stringify(new URL('../src/', import.meta.url).href)};
  export async function resolve(spec, ctx, next) {
    if (spec === 'next/server') return next('next/server.js', ctx);
    if (spec.startsWith('@/')) return next(src + spec.slice(2) + (spec.endsWith('.js') ? '' : '.js'), ctx);
    return next(spec, ctx);
  }`)}`);

const { connect, M } = await import('../src/lib/db.js');
const { dateKey } = await import('../src/lib/dates.js');
const tx = await import('../src/lib/aiTransfer.js');
const vx = await import('../voice/worker/src/transfer.js');
await connect();

const results = [];
const check = (name, ok, detail = '') => { results.push(ok); console.log(ok ? 'PASS' : 'FAIL', name, detail); };
const tag = `tx-test-${Date.now()}`;
const made = { users: [], leads: [], calls: [], att: [] };
try {
  await M.Setting.updateOne({ key: 'system' }, { $set: { aiTransferEnabled: true, aiTransferMode: 'SEQUENTIAL', aiTransferRingSec: 20, aiTransferNeedCheckIn: true } }, { upsert: true });
  const mk = (n, mobile, extra = {}) => ({ name: `${tag} ${n}`, email: `${tag}-${n}@example.test`.toLowerCase(), mobile, role: 'EMPLOYEE', status: 'ACTIVE', aiTransfer: true, passwordHash: 'x', ...extra });
  const [owner, priya, away, noTx] = await M.User.insertMany([mk('Owner', '9111100001'), mk('Priya', '9111100002'), mk('Away', '9111100003'), mk('NoTransfer', '9111100004', { aiTransfer: false })], { lean: true });
  made.users.push(owner._id, priya._id, away._id, noTx._id);
  const now = new Date();
  // Owner and Priya and NoTransfer are in the office; Away checked out.
  made.att = (await M.Attendance.insertMany([owner, priya, noTx].map((u) => ({ user: u._id, date: dateKey(), status: 'ACTIVE', sessions: [{ checkIn: now }] }))
    .concat([{ user: away._id, date: dateKey(), status: 'ACTIVE', sessions: [{ checkIn: now, checkOut: now }] }]), { lean: true })).map((a) => a._id);
  const [lead] = await M.Lead.insertMany([{ name: `${tag} Lead`, phone: '9000000009', phoneKey: '9000000009', status: 'CONTACTED', assignedTo: owner._id }]);
  made.leads.push(lead._id);
  const [call] = await M.AiCall.insertMany([{ callId: `${tag}-call`, status: 'IN_PROGRESS', lead: lead._id, phone: '+919000000009', summary: 'Wants a website.' }]);
  made.calls.push(call._id);

  const t = await tx.transferTargets(call.callId);
  check('Only checked-in people who receive transfers', t.enabled && t.targets.length === 2 && t.targets.every((x) => !/Away|NoTransfer/.test(x.name)), t.targets.map((x) => x.name).join(', '));
  check("The lead's owner is rung first", /Owner/.test(t.targets[0]?.name || ''), t.targets[0]?.name);
  check('Numbers are E.164', t.targets.every((x) => /^\+91\d{10}$/.test(x.phone)));

  await tx.ingestTransferEvent({ event: 'call.transfer', callId: call.callId, status: 'RINGING', toUserId: String(owner._id), toName: owner.name, whisper: 'Wants a website' });
  const ring = await M.Notification.findOne({ user: owner._id, title: /Incoming AI transfer/ });
  check('The person being rung gets a notification', !!ring, ring?.title);
  const busy = await tx.transferTargets(`${tag}-other`);
  check('Someone being rung is not offered to another caller', !busy.targets.some((x) => x.id === String(owner._id)), busy.targets.map((x) => x.name).join(', '));

  await tx.ingestTransferEvent({ event: 'call.transfer', callId: call.callId, status: 'CONNECTED', toUserId: String(owner._id), toName: owner.name });
  await tx.ingestTransferEvent({ event: 'call.transfer', callId: call.callId, status: 'ENDED', durationSec: 95 });
  await tx.ingestTransferEvent({ event: 'call.transfer', callId: call.callId, status: 'ENDED', durationSec: 95 }); // repeated webhook
  await tx.ingestTransferEvent({ event: 'call.transfer.recording', callId: call.callId, recording: { id: 'rec-1', durationSec: 100 } });
  await tx.ingestTransferEvent({ event: 'call.transfer.summary', callId: call.callId, summary: 'Customer wants a school website; demo on Monday.',
    transcript: [{ role: 'team', content: 'Hello, Shine se bol raha hoon' }, { role: 'customer', content: 'Website chahiye' }] });
  const c1 = await M.AiCall.findById(call._id).lean();
  check('Call shows who took it and for how long', c1.transfer.status === 'ENDED' && String(c1.transfer.to) === String(owner._id) && c1.transfer.durationSec === 95, `${c1.transfer.status} ${c1.transfer.toName} ${c1.transfer.durationSec}s`);
  check('Transfer recording, transcript and summary are stored', c1.transfer.recordingId === 'rec-1' && c1.transfer.transcript.length === 2 && /school website/.test(c1.transfer.summary));
  const acts = await M.LeadActivity.find({ lead: lead._id, type: 'CALL' }).lean();
  check("Counts once as the person's call on the lead, with the summary", acts.length === 1 && String(acts[0].by) === String(owner._id) && /school website/.test(acts[0].note), `${acts.length} call(s): ${acts[0]?.note}`);

  // Nobody picks up
  const [call2] = await M.AiCall.insertMany([{ callId: `${tag}-call2`, status: 'IN_PROGRESS', lead: lead._id, phone: '+919000000009' }]);
  made.calls.push(call2._id);
  await tx.ingestTransferEvent({ event: 'call.transfer', callId: call2.callId, status: 'NO_ANSWER', reason: 'no-answer' });
  const c2 = await M.AiCall.findById(call2._id).lean();
  const l2 = await M.Lead.findById(lead._id).lean();
  check('Missed transfer becomes a callback with a follow-up', c2.callbackRequested && c2.callbackAt && l2.nextFollowUpAt && l2.status === 'FOLLOW_UP', `${c2.callbackAt?.toISOString()} / lead ${l2.status}`);
  const missed = await M.Notification.findOne({ user: owner._id, title: /Missed live transfer/ });
  check('Owner is told about the missed transfer', !!missed, missed?.title);

  await M.Setting.updateOne({ key: 'system' }, { $set: { aiTransferEnabled: false } });
  const off = await tx.transferTargets(call2.callId);
  check('Switched off: nobody is rung', !off.enabled && !off.targets.length, off.reason);
  await M.Setting.updateOne({ key: 'system' }, { $set: { aiTransferEnabled: true } });

  // VoBiz XML from the voice worker
  const env = { PUBLIC_URL: 'https://voice.example', STAGING_TOKEN: 't&k', VOBIZ_NUMBER: '+918065354620', RECORDINGS_PREFIX: 'calls' };
  const plan = { mode: 'SEQUENTIAL', ringSec: 20, targets: [{ id: '1', name: 'A', phone: '+919111100001' }, { id: '2', name: 'B', phone: '+919111100002' }] };
  const x0 = vx.dialXml(env, 'abc-123', plan, 0, { record: true });
  check('First XML records the session and rings only the first person', /<Record recordSession="true"[^>]*maxLength="3600"/.test(x0) && (x0.match(/<Number>/g) || []).length === 1 && x0.includes('+919111100001'));
  check('URLs in the XML are escaped', x0.includes('&amp;t=t%26k') && !/&t=/.test(x0));
  const x1 = vx.dialXml(env, 'abc-123', plan, 1, { record: false });
  check('Next attempt rings the next person without a second recording', !x1.includes('<Record') && x1.includes('+919111100002') && x1.includes('i=1'));
  const xa = vx.dialXml(env, 'abc-123', { ...plan, mode: 'ALL' }, 0, { record: true });
  check('"Everyone at once" rings all numbers together', (xa.match(/<Number>/g) || []).length === 2);
  check('Answered number maps back to the person', vx.targetFor(plan, '919111100002')?.name === 'B');
} catch (e) {
  check('run', false, e.stack);
} finally {
  await Promise.all([
    M.AiCall.deleteMany({ _id: { $in: made.calls } }), M.LeadActivity.deleteMany({ lead: { $in: made.leads } }), M.Lead.deleteMany({ _id: { $in: made.leads } }),
    M.Attendance.deleteMany({ _id: { $in: made.att } }), M.Notification.deleteMany({ user: { $in: made.users } }), M.User.deleteMany({ _id: { $in: made.users } }),
  ]);
  console.log(`${results.filter(Boolean).length}/${results.length} checks passed`);
  await mongoose.disconnect().catch(() => {});
  process.exit(results.every(Boolean) ? 0 : 1);
}
