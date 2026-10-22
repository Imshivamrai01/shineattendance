// Tests office-line calls without placing calls: a local fake voice worker accepts /api/bridge; events from VoBiz are
// replayed into the CRM. Needs MONGODB_URI pointing at a TEST database (never production):
//   MONGODB_URI=<staging uri> node scripts/office-call-test.mjs
import http from 'node:http';
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

const bridges = [];
let n = 0;
const fake = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => { body += c; });
  req.on('end', () => {
    res.setHeader('content-type', 'application/json');
    if (req.url === '/api/bridge') { bridges.push(JSON.parse(body)); return res.end(JSON.stringify({ callId: `bridge-${Date.now()}-${++n}` })); }
    res.statusCode = 404; res.end('{}');
  });
}).listen(0);
await new Promise((r) => fake.on('listening', r));
Object.assign(process.env, { VOICE_API_URL: `http://127.0.0.1:${fake.address().port}`, AI_WEBHOOK_SECRET: 'test-secret' });

const { connect, M } = await import('../src/lib/db.js');
const oc = await import('../src/lib/officeCalls.js');
await connect();
const results = [];
const check = (name, ok, detail = '') => { results.push(ok); console.log(ok ? 'PASS' : 'FAIL', name, detail); };
const tag = `office-test-${Date.now()}`;
const made = { users: [], leads: [] };
try {
  await M.Setting.updateOne({ key: 'system' }, { $set: { officeLineEnabled: true } }, { upsert: true });
  const [agent, noMobile] = await M.User.insertMany([
    { name: `${tag} Agent`, email: `${tag}-a@example.test`, mobile: '9111100011', role: 'EMPLOYEE', status: 'ACTIVE', passwordHash: 'x', salesAccess: 'AGENT' },
    { name: `${tag} NoMobile`, email: `${tag}-b@example.test`, role: 'EMPLOYEE', status: 'ACTIVE', passwordHash: 'x', salesAccess: 'AGENT' }], { lean: true });
  made.users.push(agent._id, noMobile._id);
  const ctx = { user: agent, sales: 'AGENT' };
  const line = await oc.officeLine(agent);
  check('Office line is on for someone with a mobile', line.enabled && /\d{4}$/.test(line.mobile), JSON.stringify(line));
  const off = await oc.officeLine(noMobile);
  check('No mobile in profile: falls back to the phone dialer', !off.enabled && /mobile/i.test(off.reason), off.reason);

  const mkLead = async (n) => (await M.Lead.create({ name: `${tag} ${n}`, phone: `90000001${n}`, phoneKey: `90000001${n}`, status: 'NEW', assignedTo: agent._id }));
  const lead = await mkLead('11');
  made.leads.push(lead._id);
  const act = await oc.startOfficeCall(ctx, lead);
  const sent = bridges.at(-1);
  check('Rings the caller first, then the lead (both E.164)', sent.agent.phone === '+919111100011' && sent.lead.phone === '+919000000111' && sent.activityId === String(act._id), JSON.stringify({ agent: sent.agent.phone, lead: sent.lead.phone }));
  check('Call is on the lead right away, waiting for the result', act.outcome === 'PENDING' && act.bridge.status === 'CALLING_AGENT' && /^bridge-/.test(act.bridge.callId));
  let second = null;
  try { await oc.startOfficeCall(ctx, lead); } catch (e) { second = e; }
  check('A second call while one is live is refused', second?.status === 409, second?.message);

  const id = act.bridge.callId;
  for (const ev of [{ event: 'bridge.status', status: 'RINGING_LEAD' }, { event: 'bridge.status', status: 'CONNECTED' }, { event: 'bridge.status', status: 'ENDED', talkSec: 125 },
    { event: 'bridge.status', status: 'ENDED', talkSec: 125 }, { event: 'bridge.recording', recording: { id: 'rec-9', durationSec: 130 } },
    { event: 'bridge.summary', summary: 'Lead wants a demo on Friday.', transcript: [{ role: 'team', content: 'Hello, Shine se' }, { role: 'customer', content: 'Demo chahiye' }] }]) {
    await oc.ingestBridgeEvent({ ...ev, callId: id });
  }
  const a1 = await M.LeadActivity.findById(act._id).lean();
  check('Live status, talk time, recording, transcript and summary are stored', a1.bridge.status === 'ENDED' && a1.bridge.talkSec === 125 && a1.durationSec === 125 && a1.bridge.recordingId === 'rec-9' && a1.bridge.transcript.length === 2,
    `${a1.bridge.status} ${a1.bridge.talkSec}s rec=${a1.bridge.recordingId}`);
  check('Summary fills "what was said"; outcome still the caller\'s choice', a1.note === 'Lead wants a demo on Friday.' && a1.outcome === 'PENDING', a1.note);

  const lead2 = await mkLead('12');
  made.leads.push(lead2._id);
  const act2 = await oc.startOfficeCall(ctx, lead2);
  await oc.ingestBridgeEvent({ event: 'bridge.status', callId: act2.bridge.callId, status: 'RINGING_LEAD' });
  await oc.ingestBridgeEvent({ event: 'bridge.status', callId: act2.bridge.callId, status: 'NO_ANSWER', reason: 'no-answer' });
  const a2 = await M.LeadActivity.findById(act2._id).lean();
  const l2 = await M.Lead.findById(lead2._id).lean();
  check('Lead didn\'t pick up: saved as "No answer" automatically', a2.outcome === 'NO_ANSWER' && l2.lastOutcome === 'NO_ANSWER' && l2.status === 'CONTACTED', `${a2.outcome} / lead ${l2.status}`);

  const lead3 = await mkLead('13');
  made.leads.push(lead3._id);
  const act3 = await oc.startOfficeCall(ctx, lead3);
  await oc.ingestBridgeEvent({ event: 'bridge.status', callId: act3.bridge.callId, status: 'AGENT_NO_ANSWER' });
  const a3 = await M.LeadActivity.findById(act3._id).lean();
  const l3 = await M.Lead.findById(lead3._id).lean();
  check('Caller didn\'t pick up: lead not counted as called', a3.bridge.status === 'AGENT_NO_ANSWER' && l3.callCount === 0, `callCount ${l3.callCount}`);

  await M.Setting.updateOne({ key: 'system' }, { $set: { officeLineEnabled: false } });
  check('Switched off: Call button uses the phone dialer', !(await oc.officeLine(agent)).enabled);
  await M.Setting.updateOne({ key: 'system' }, { $set: { officeLineEnabled: true } });
} catch (e) {
  check('run', false, e.stack);
} finally {
  await Promise.all([M.LeadActivity.deleteMany({ lead: { $in: made.leads } }), M.Lead.deleteMany({ _id: { $in: made.leads } }), M.User.deleteMany({ _id: { $in: made.users } })]);
  fake.close();
  console.log(`${results.filter(Boolean).length}/${results.length} checks passed`);
  await mongoose.disconnect().catch(() => {});
  process.exit(results.every(Boolean) ? 0 : 1);
}
