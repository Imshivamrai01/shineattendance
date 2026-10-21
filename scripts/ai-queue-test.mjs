// Tests the AI call list end to end without placing calls: a local fake voice worker records dial requests.
// Needs MONGODB_URI pointing at a TEST database (never production). Usage:
//   MONGODB_URI=<staging uri> node scripts/ai-queue-test.mjs
import http from 'node:http';
import { register } from 'node:module';
import mongoose from 'mongoose';

// The lib files are written for Next.js: map 'next/server' and the '@/' alias for plain Node.
register(`data:text/javascript,${encodeURIComponent(`
  const src = ${JSON.stringify(new URL('../src/', import.meta.url).href)};
  export async function resolve(spec, ctx, next) {
    if (spec === 'next/server') return next('next/server.js', ctx);
    if (spec.startsWith('@/')) return next(src + spec.slice(2) + (spec.endsWith('.js') ? '' : '.js'), ctx);
    return next(spec, ctx);
  }`)}`);

if (!/staging|test/i.test(process.env.MONGODB_URI || '')) { console.error('Refusing: MONGODB_URI must be a staging/test database'); process.exit(1); }

const dials = [];
let n = 0;
const fake = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => { body += c; });
  req.on('end', () => {
    if (req.url === '/api/call') { dials.push(JSON.parse(body)); res.setHeader('content-type', 'application/json'); return res.end(JSON.stringify({ callId: `fake-${Date.now()}-${++n}` })); }
    res.statusCode = 404; res.end();
  });
}).listen(0);
await new Promise((r) => fake.on('listening', r));
Object.assign(process.env, { VOICE_API_URL: `http://127.0.0.1:${fake.address().port}`, AI_WEBHOOK_SECRET: 'test-secret', AI_CALL_WINDOW: '00:00-23:59' });

const { connect, M } = await import('../src/lib/db.js');
const ai = await import('../src/lib/aiCalls.js');
await connect();
const flush = () => new Promise((r) => setTimeout(r, 1500)); // let defer()red work run

const results = [];
const check = (name, ok, detail = '') => { results.push(ok); console.log(ok ? 'PASS' : 'FAIL', name, detail); };
const tag = `queue-test-${Date.now()}`;
const admin = await M.User.findOne({ role: 'ADMIN' }).lean();
const ctx = { sales: 'MANAGER', user: { _id: admin._id, name: 'Queue test' } };
try {
  const [a, b, c, d] = await M.Lead.insertMany([
    { name: `${tag} A`, phone: '+91 90000 00001', phoneKey: '9000000001', status: 'NEW' },
    { name: `${tag} B`, phone: '9000000002', phoneKey: '9000000002', status: 'CONTACTED' },
    { name: `${tag} C landline`, phone: '0120 4567890', phoneKey: '1204567890', status: 'NEW' },
    { name: `${tag} D`, phone: '9000000004', phoneKey: '9000000004', status: 'NOT_INTERESTED', notes: 'Asked not to be called (AI call).' },
  ]);
  const q = await ai.queueAiCalls(ctx, [a._id, b._id, c._id, d._id], { purpose: 'test' });
  check('Queues callable leads, skips landline and do-not-call', q.queued === 2 && q.skipped.length === 2, JSON.stringify(q.skipped.map((s) => s.reason)));
  const again = await ai.queueAiCalls(ctx, [a._id], {});
  check('Same lead is not queued twice', again.queued === 0 && /already/.test(again.skipped[0]?.reason), again.skipped[0]?.reason);
  await flush();
  check('Dials only one at a time', dials.length === 1 && dials[0].lead.id === String(a._id), `${dials.length} dial(s)`);
  await ai.dialNext();
  check('No second dial while the first call is live', dials.length === 1);

  const first = await M.AiCall.findOne({ lead: a._id, status: 'QUEUED' });
  check('Placeholder got the carrier call id', /^fake-/.test(first?.callId || ''), first?.callId);
  await ai.ingestAiEvent({ event: 'call.ended', callId: first.callId, direction: 'outbound', phone: '+919000000001',
    transcript: [{ role: 'assistant', content: 'Namaste' }, { role: 'user', content: 'Haan, interested hoon' }],
    extract: { outcome: 'INTERESTED', interest: 'HOT', name: 'A', requirement: 'Website', summary: 'Interested in a website.' } });
  await flush();
  check('Next lead is dialled when the call ends', dials.length === 2 && dials[1].lead.id === String(b._id), `${dials.length} dial(s)`);
  const leadA = await M.Lead.findById(a._id).lean();
  check('Interested call marks the lead Interested', leadA.status === 'INTERESTED', leadA.status);
  const note = await M.Notification.findOne({ title: 'Interested lead from an AI call', body: new RegExp(tag) });
  check('Sales is notified about the interested lead', !!note, note?.body);

  // CRM page: interview invites to a pasted list (no sales leads)
  const scripts = await ai.aiScripts();
  const interview = scripts.find((x) => x.kind === 'INTERVIEW');
  check('Default call types exist', ['SALES', 'INTERVIEW', 'FEEDBACK'].every((k) => scripts.some((x) => x.kind === k)), scripts.map((x) => x.name).join(', '));
  await M.AiCall.updateMany({ status: { $in: ['QUEUED', 'IN_PROGRESS'] }, lead: { $in: [a._id, b._id] } }, { $set: { status: 'COMPLETED' } });
  const leadsBefore = await M.Lead.countDocuments();
  const cq = await ai.queueContacts(ctx, [{ name: `${tag} Candidate`, phone: '9000000005' }, { name: 'Bad', phone: '12345' }], { scriptId: interview._id, purpose: 'Interview 25 Oct 11 am' });
  check('CRM list queues mobiles and skips bad numbers', cq.queued === 1 && cq.skipped.length === 1, JSON.stringify(cq.skipped));
  await flush();
  const cd = dials.at(-1);
  check('Interview call carries its call type and details', cd?.script?.kind === 'INTERVIEW' && cd.lead.name === `${tag} Candidate` && !cd.lead.id && /25 Oct/.test(cd.lead.purpose), JSON.stringify({ type: cd?.script?.name, name: cd?.lead?.name, details: cd?.lead?.purpose }));
  const cCall = await M.AiCall.findOne({ contactName: `${tag} Candidate` });
  await ai.ingestAiEvent({ event: 'call.ended', callId: cCall.callId, direction: 'outbound', phone: '+919000000005',
    transcript: [{ role: 'assistant', content: 'Interview invite' }, { role: 'user', content: 'Haan aa jaunga' }],
    extract: { outcome: 'INFO_GIVEN', summary: 'Will attend the interview.', accepted: true, appointmentAt: '2026-10-25T11:00:00+05:30' } });
  await flush();
  const after = await M.AiCall.findById(cCall._id).lean();
  check('Interview answer is stored', after.accepted === true && after.appointmentAt?.toISOString() === '2026-10-25T05:30:00.000Z', `${after.accepted} ${after.appointmentAt?.toISOString()}`);
  check('No sales lead is created for an interview call', (await M.Lead.countDocuments()) === leadsBefore && !after.lead);
  const iNote = await M.Notification.findOne({ user: admin._id, title: new RegExp(`${tag} Candidate accepted the interview`) });
  check('Whoever started it is told the answer', !!iNote, iNote?.title);
  await M.Notification.deleteMany({ title: new RegExp(tag) });
  await M.AiCall.deleteMany({ contactName: new RegExp(tag) });

  await M.AiCall.insertMany([{ callId: `list-${new mongoose.Types.ObjectId()}`, status: 'SCHEDULED', lead: c._id, phone: '+911204567890', requestedBy: admin._id }]);
  const cancelled = await ai.cancelQueued(ctx);
  check('Stop the list removes waiting calls', cancelled.cancelled >= 1, `${cancelled.cancelled} removed`);
  process.env.AI_CALL_WINDOW = '00:00-00:00';
  const outside = await ai.dialNext();
  check('Nothing is dialled outside calling hours', outside.reason === 'outside calling hours' || outside.dialled === 0, JSON.stringify(outside));
} catch (e) {
  check('run', false, e.stack);
} finally {
  const leads = await M.Lead.find({ name: new RegExp(`^${tag}`) }).distinct('_id');
  await Promise.all([M.AiCall.deleteMany({ lead: { $in: leads } }), M.LeadActivity.deleteMany({ lead: { $in: leads } }),
    M.Notification.deleteMany({ body: new RegExp(tag) }), M.Lead.deleteMany({ _id: { $in: leads } })]);
  fake.close();
  console.log(`${results.filter(Boolean).length}/${results.length} checks passed`);
  await mongoose.disconnect().catch(() => {});
  process.exit(results.every(Boolean) ? 0 : 1);
}
