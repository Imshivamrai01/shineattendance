// End-to-end API check against a throwaway in-memory MongoDB and a production build.
//   npm run build && npm run test:smoke
import { MongoMemoryServer } from 'mongodb-memory-server';
import { spawn, spawnSync } from 'node:child_process';
import assert from 'node:assert/strict';
import { SMTPServer } from 'smtp-server';
import { simpleParser } from 'mailparser';
import { awayMs, dayFlags, label12, workedHours } from '../src/lib/hours.js';
import { normalizePhone } from '../src/lib/whatsapp.js';
import { startWaMock } from './wa-mock.mjs';
import { sessionCodes } from '../src/lib/presence.js';
import { taskPoints } from '../src/lib/taskScore.js';

// A local SMTP server that records every email the app sends, so recipients and content can be checked.
const outbox = [];
const smtp = new SMTPServer({
  authOptional: true, allowInsecureAuth: true, disabledCommands: ['STARTTLS'],
  onAuth: (a, s, cb) => cb(null, { user: 'test' }),
  onData(stream, s, cb) { simpleParser(stream).then((m) => { outbox.push({ to: (m.to?.value || []).map((x) => x.address.toLowerCase()), subject: m.subject, text: m.text || '', html: m.html || '' }); cb(); }).catch(cb); },
});
await new Promise((res) => smtp.listen(2525, '127.0.0.1', res));
const mailsTo = (addr) => outbox.filter((m) => m.to.includes(addr));
const has = (addr, re) => mailsTo(addr).some((m) => re.test(m.subject));

const PORT = 3111, BASE = `http://localhost:${PORT}`;
const mongo = await MongoMemoryServer.create();
const env = { ...process.env, MONGODB_URI: mongo.getUri('smoke'), ADMIN_EMAIL: 'admin@shineinfo.in', ADMIN_INITIAL_PASSWORD: 'Shineinfo@2026', NODE_ENV: 'production', CLOUDINARY_CLOUD_NAME: '', CLOUDINARY_API_KEY: '', CLOUDINARY_API_SECRET: '', SMTP_USER: 'test', SMTP_PASS: 'test', SMTP_HOST: '127.0.0.1', SMTP_PORT: '2525', SMTP_INSECURE: '1', SMTP_FROM: 'Shine <noreply@test.local>', APP_URL: 'https://app.test.local', CRON_SECRET: 'cron-secret-for-tests', REPORT_EMAIL: 'report@test.local', PRESENCE_OUT_SECONDS: '0', PRESENCE_SILENT_MINUTES: '0', PRESENCE_REPLY_MINUTES: '0', PRESENCE_COOLDOWN_MINUTES: '0', WHATSAPP_GRAPH_URL: 'http://127.0.0.1:3999' };
const wa = startWaMock(3999);

const seed = () => new Promise((res) => { let out = ''; const p = spawn('node', ['scripts/seed-admin.mjs'], { env }); p.stdout.on('data', (d) => (out += d)); p.stderr.on('data', (d) => (out += d)); p.on('exit', () => res({ stdout: out, stderr: '' })); });
let r = await seed(); assert.match(r.stdout, /created/, r.stdout + r.stderr);
r = await seed(); assert.match(r.stdout, /already exists/, 'seed must be idempotent');

const server = spawn('npx', ['next', 'start', '-p', String(PORT)], { env, shell: true, stdio: 'ignore' });
const cleanup = async () => { spawnSync('taskkill', ['/pid', String(server.pid), '/T', '/F']); await mongo.stop(); smtp.close(); wa.close(); };

class Client {
  constructor() { this.cookie = ''; }
  async call(method, path, body) {
    const res = await fetch(BASE + path, { method, headers: { 'content-type': 'application/json', cookie: this.cookie }, body: body ? JSON.stringify(body) : undefined });
    const sc = res.headers.get('set-cookie'); if (sc) this.cookie = sc.split(';')[0];
    const text = await res.text(); let data; try { data = JSON.parse(text); } catch { data = text; }
    return { status: res.status, data };
  }
}
const ok = (x, s = 200) => { assert.equal(x.status, s, JSON.stringify(x.data)); return x.data; };
let step = 0; const t = (m) => console.log(`✓ ${++step}. ${m}`);

try {
  for (let i = 0; i < 60; i++) { try { await fetch(BASE + '/login'); break; } catch { await new Promise((r) => setTimeout(r, 1000)); } }
  const admin = new Client();

  assert.equal((await admin.call('POST', '/api/auth/login', { identifier: 'admin@shineinfo.in', password: 'wrong' })).status, 401); t('bad password rejected');
  const login = ok(await admin.call('POST', '/api/auth/login', { identifier: 'admin@shineinfo.in', password: 'Shineinfo@2026' }));
  assert.equal(login.mustChangePassword, true); t('admin login, forced password change flag');
  assert.equal((await admin.call('GET', '/api/users')).status, 403); t('API blocked until password changed');
  assert.equal((await admin.call('POST', '/api/auth/change-password', { currentPassword: 'Shineinfo@2026', newPassword: 'weak' })).status, 400);
  ok(await admin.call('POST', '/api/auth/change-password', { currentPassword: 'Shineinfo@2026', newPassword: 'NewSecure#Pass9' })); t('password changed');
  ok(await admin.call('PATCH', '/api/settings', { notificationEmail: 'admin-inbox@test.local', reason: 'Set notification email' }));
  // Office hours: defaults 10:00-18:00, validated; then widened so every test check-in counts as late / every check-out as early
  const cfg0 = ok(await admin.call('GET', '/api/settings')).settings;
  assert.equal(cfg0.workStart, '10:00'); assert.equal(cfg0.workEnd, '18:00');
  assert.equal((await admin.call('PATCH', '/api/settings', { workStart: '18:00', workEnd: '10:00', reason: 'invalid times' })).status, 400);
  ok(await admin.call('PATCH', '/api/settings', { workStart: '00:01', workEnd: '23:59', lunchStart: '00:00', lunchEnd: '00:01', reason: 'Test office hours' })); t('office hours default 10:00-18:00 and validated');
  // dayFlags: IST 10:25 check-in is 25 min late, IST 17:00 check-out is 60 min early (UTC 04:55 / 11:30)
  const fl = dayFlags({ sessions: [{ checkIn: '2026-09-29T04:55:00Z', checkOut: '2026-09-29T11:30:00Z' }] }, { workStart: '10:00', workEnd: '18:00', graceMinutes: 0 });
  assert.deepEqual([fl.late, fl.lateMinutes, fl.early, fl.earlyMinutes], [true, 25, true, 60]);
  assert.equal(dayFlags({ sessions: [{ checkIn: '2026-09-29T04:30:00Z', checkOut: '2026-09-29T12:30:00Z' }] }, { workStart: '10:00', workEnd: '18:00' }).late, false);
  assert.equal(dayFlags({ sessions: [{ checkIn: '2026-09-29T04:40:00Z' }] }, { workStart: '10:00', workEnd: '18:00', graceMinutes: 15 }).late, false);
  assert.equal(label12('18:00'), '6:00 PM'); t('late / left-early rules');
  // Time away is deducted, except the part inside lunch (1:30 - 2:30 PM IST = 08:00 - 09:00 UTC)
  const day = (breaks) => ({ date: '2026-09-29', sessions: [{ checkIn: '2026-09-29T04:30:00Z', checkOut: '2026-09-29T12:30:00Z', breaks }] });
  assert.equal(workedHours(day([])), 8);
  assert.equal(workedHours(day([{ outAt: '2026-09-29T06:00:00Z', backAt: '2026-09-29T06:45:00Z' }])), 7.25);  // 45 min away in the morning
  assert.equal(workedHours(day([{ outAt: '2026-09-29T08:05:00Z', backAt: '2026-09-29T08:55:00Z' }])), 8);     // away during lunch only
  assert.equal(workedHours(day([{ outAt: '2026-09-29T07:50:00Z', backAt: '2026-09-29T09:20:00Z' }])), 7.5);   // 10 min before + 20 min after lunch
  assert.equal(awayMs({ outAt: '2026-09-29T07:50:00Z', backAt: '2026-09-29T09:20:00Z' }, '2026-09-29') / 60000, 30);
  assert.equal(workedHours(day([{ outAt: '2026-09-29T06:00:00Z', backAt: '2026-09-29T06:30:00Z' }]), { lunchStart: '11:30', lunchEnd: '12:30' }), 8); t('hours: time away deducted, lunch break excepted');

  // Empty system works
  const dash = ok(await admin.call('GET', '/api/dashboard'));
  assert.equal(dash.overview.counts.employees, 0); assert.equal(dash.checklist.filter((c) => c.done).length, 2); t('empty system: zero counts, only admin + notification email done');
  assert.deepEqual(ok(await admin.call('GET', '/api/users')).items, []); t('empty user list');

  // Setup
  const dept = ok(await admin.call('POST', '/api/departments', { name: 'Sales' })).item;
  const loc = ok(await admin.call('POST', '/api/locations', { name: 'HQ', latitude: 26.7606, longitude: 83.3732, radiusMeters: 100 })).item; t('department + location created');
  const mgr = ok(await admin.call('POST', '/api/users', { role: 'MANAGER', employeeId: 'M-001', name: 'Amit Singh', email: 'amit@example.com' }));
  assert.ok(mgr.tempPassword); t('manager created with minimal data');
  const hr = ok(await admin.call('POST', '/api/users', { role: 'HR', employeeId: 'H-001', name: 'Hina HR', mobile: '9876500001' }));
  // Partial employee: only name, email, department, manager
  const emp = ok(await admin.call('POST', '/api/users', { role: 'EMPLOYEE', employeeId: 'e-101', name: 'Rahul Kumar', email: 'rahul@example.com', department: dept._id, manager: mgr.user._id, hr: hr.user._id, location: loc._id }));
  assert.equal(emp.user.employeeId, 'E-101'); assert.ok(emp.user.completion.percent < 100); t('partial employee created with given ID (normalised), completion < 100%');
  assert.equal((await admin.call('POST', '/api/users', { role: 'EMPLOYEE', name: 'No ID' })).status, 400); t('employee ID required');
  assert.equal((await admin.call('POST', '/api/users', { role: 'EMPLOYEE', employeeId: 'E-101', name: 'Same ID' })).status, 409); t('duplicate employee ID rejected');
  assert.equal((await admin.call('POST', '/api/users', { role: 'EMPLOYEE', employeeId: 'E-999', name: 'Dup', email: 'rahul@example.com' })).status, 409); t('duplicate email rejected');

  // Employee login + geofence
  const e = new Client();
  ok(await e.call('POST', '/api/auth/login', { identifier: 'rahul@example.com', password: emp.tempPassword }));
  ok(await e.call('POST', '/api/auth/change-password', { currentPassword: emp.tempPassword, newPassword: 'Employee#Pass1' }));
  const far = await e.call('POST', '/api/attendance/check-in', { lat: 28.6, lng: 77.2 });
  assert.equal(far.status, 403); t('check-in outside geofence blocked');
  // Office start is 00:01 in this test, so the first check-in of the day is late and needs a reason
  assert.ok(ok(await e.call('GET', '/api/dashboard')).today.lateMinutes > 0);
  const noLate = await e.call('POST', '/api/attendance/check-in', { lat: 26.7607, lng: 83.3733 });
  assert.equal(noLate.status, 400); assert.equal(noLate.data.code, 'LATE_REASON_REQUIRED');
  const first = ok(await e.call('POST', '/api/attendance/check-in', { lat: 26.7607, lng: 83.3733, lateReason: 'Bike broke down on the way' })).record;
  assert.equal(first.sessions[0].lateReason, 'Bike broke down on the way'); assert.equal(ok(await e.call('GET', '/api/dashboard')).today.lateMinutes, 0); t('check-in inside geofence; late check-in needs a reason');
  assert.equal((await e.call('POST', '/api/attendance/check-in', { lat: 26.7607, lng: 83.3733 })).status, 409); t('double check-in blocked');
  ok(await e.call('POST', '/api/attendance/check-out', { lat: 26.7607, lng: 83.3733 })); t('check-out');

  // Weak GPS is rejected at check-in
  const weak = await e.call('POST', '/api/attendance/check-in', { lat: 28.6, lng: 77.2, accuracy: 120 });
  assert.equal(weak.status, 403); assert.match(weak.data.error, /not in the office/); t('outside + weak GPS => "not in the office"');
  ok(await e.call('POST', '/api/attendance/check-in', { lat: 26.7607, lng: 83.3733, accuracy: 5 }));
  const IN = { lat: 26.7607, lng: 83.3733, accuracy: 5 }, OUT = { lat: 26.7650, lng: 83.3732, accuracy: 5 }; // OUT is ~490 m away, a precise fix
  const pingAs = async (who, body) => ok(await who.call('POST', '/api/attendance/ping', body));
  const inside = await pingAs(e, IN);
  assert.equal(inside.open, true); assert.equal(inside.check, null);
  assert.equal((await pingAs(e, { lat: 26.7612, lng: 83.3732, accuracy: 5 })).warning, undefined); // 67 m: well inside the 100 m geofence
  // A far-away reading that is not a precise GPS fix (cell tower / Wi-Fi) never counts, however often it comes
  for (let i = 0; i < 4; i++) assert.equal((await pingAs(e, { ...OUT, accuracy: 40 })).uncertain, true);
  // Three precise fixes outside: the person is ASKED "Still in office?". Nobody is checked out by the location.
  assert.equal((await pingAs(e, OUT)).warning, true); assert.equal((await pingAs(e, OUT)).check, null);
  const asked = await pingAs(e, OUT);
  assert.equal(asked.open, true); assert.equal(asked.check.status, 'ASKED'); assert.equal(asked.check.reason, 'GEOFENCE_EXIT'); assert.ok(asked.check.distance > 400);
  let myDay = ok(await e.call('GET', '/api/dashboard')).today;
  assert.equal(myDay.checkedIn, true); assert.equal(myDay.presence.status, 'ASKED'); t('geofence exit => "Still in office?" is asked, the session stays open');

  // "Yes, in the office" while a precise fix says otherwise is not accepted on its own: it goes to review
  assert.equal(ok(await e.call('POST', '/api/attendance/presence', { answer: 'IN_OFFICE', ...OUT })).status, 'REVIEW_REQUIRED');
  assert.equal((await e.call('POST', '/api/attendance/presence', { answer: 'IN_OFFICE', ...IN })).status, 409); // already answered
  const queue = ok(await admin.call('GET', '/api/attendance?review=1')).items;
  assert.equal(queue.length, 1); assert.equal(queue[0].canReview, true);
  const openSession = queue[0].sessions.find((x) => !x.checkOut), chk = openSession.checks[0];
  assert.deepEqual(sessionCodes(openSession).map((k) => k.code), ['GEOFENCE_EXIT', 'REVIEW_REQUIRED']);
  assert.equal((await e.call('POST', `/api/attendance/${queue[0]._id}/review`, { checkId: chk._id, decision: 'STAYED', note: 'I was inside' })).status, 403);
  assert.equal((await admin.call('POST', `/api/attendance/${queue[0]._id}/review`, { checkId: chk._id, decision: 'STAYED' })).status, 400); // a note is required
  ok(await admin.call('POST', `/api/attendance/${queue[0]._id}/review`, { checkId: chk._id, decision: 'STAYED', note: 'Was in the basement meeting room' }));
  assert.equal((await admin.call('POST', `/api/attendance/${queue[0]._id}/review`, { checkId: chk._id, decision: 'LEFT', note: 'Changed my mind' })).status, 409);
  myDay = ok(await e.call('GET', '/api/dashboard')).today;
  assert.equal(myDay.checkedIn, true); assert.equal(myDay.presence, null); assert.equal(ok(await admin.call('GET', '/api/attendance?review=1')).items.length, 0); t('review "was in office": nothing changes, recorded with the reviewer and a note');

  // Asked again; this time the person says they left. Still only a reviewer closes the session, at the time they choose.
  await pingAs(e, OUT); await pingAs(e, OUT);
  assert.equal((await pingAs(e, OUT)).check.status, 'ASKED');
  assert.equal(ok(await e.call('POST', '/api/attendance/presence', { answer: 'LEFT' })).status, 'REVIEW_REQUIRED');
  assert.equal(ok(await e.call('GET', '/api/dashboard')).today.checkedIn, true);
  const q2 = ok(await admin.call('GET', '/api/attendance?review=1')).items[0];
  const s2 = q2.sessions.find((x) => !x.checkOut), c2 = s2.checks.find((k) => k.status === 'REVIEW_REQUIRED');
  assert.equal((await admin.call('POST', `/api/attendance/${q2._id}/review`, { checkId: c2._id, decision: 'LEFT', at: new Date(Date.now() + 3600000).toISOString(), note: 'Future time' })).status, 400);
  ok(await admin.call('POST', `/api/attendance/${q2._id}/review`, { checkId: c2._id, decision: 'LEFT', note: 'Confirmed by the guard at the gate' }));
  myDay = ok(await e.call('GET', '/api/dashboard')).today;
  const closed = myDay.record.sessions.at(-1);
  assert.equal(myDay.checkedIn, false); assert.equal(myDay.needsReason, false); assert.equal(closed.closeReason, 'REVIEW'); assert.equal(closed.checkOut, c2.since);
  assert.deepEqual(sessionCodes(closed).map((k) => k.code), ['GEOFENCE_EXIT', 'REVIEWED', 'REVIEW_CHECKOUT']); t('review "left": checked out by the reviewer at the time the location changed');

  // Back later: an ordinary new session, no reason asked
  ok(await e.call('POST', '/api/attendance/check-in', IN)); t('checking in again after a review check-out is a normal new session');
  // During lunch the location is not judged at all
  ok(await admin.call('PATCH', '/api/settings', { lunchStart: '00:00', lunchEnd: '23:59', reason: 'Simulate lunch time' }));
  for (let i = 0; i < 3; i++) { const p = await pingAs(e, OUT); assert.equal(p.lunch, true); assert.equal(p.check, null); }
  assert.equal(ok(await e.call('GET', '/api/dashboard')).office.lunchNow, true);
  ok(await admin.call('PATCH', '/api/settings', { lunchStart: '00:00', lunchEnd: '00:01', reason: 'Lunch over' })); t('lunch break: nobody is asked, shown to everyone');
  ok(await e.call('POST', '/api/attendance/check-out', IN));
  assert.equal(ok(await e.call('GET', '/api/dashboard')).today.record.sessions.at(-1).closeReason, 'MANUAL'); t('manual check-out carries its reason code');

  // Employee cannot use admin APIs or see others
  assert.equal((await e.call('GET', '/api/audit-logs')).status, 403);
  assert.equal((await e.call('GET', '/api/users')).status, 403); t('employee blocked from admin/people APIs');

  // Employee -> HR -> Manager approval
  const rq = ok(await e.call('POST', '/api/requests', { type: 'PROFILE_CHANGE', changes: { fatherName: 'Suresh Kumar', address: 'Gorakhpur' }, reason: 'Completing my profile' })).item;
  assert.equal(rq.status, 'PENDING_HR');
  const mgrC = new Client(), hrC = new Client();
  for (const [c, u, id] of [[mgrC, mgr, 'amit@example.com'], [hrC, hr, '9876500001']]) {
    ok(await c.call('POST', '/api/auth/login', { identifier: id, password: u.tempPassword }));
    ok(await c.call('POST', '/api/auth/change-password', { currentPassword: u.tempPassword, newPassword: 'Staff#Pass12' }));
  }
  assert.equal((await e.call('POST', `/api/requests/${rq._id}`, { decision: 'approve' })).status, 403); t('employee cannot approve their own request');
  ok(await hrC.call('POST', `/api/requests/${rq._id}`, { decision: 'approve' }));
  assert.equal((await hrC.call('POST', `/api/requests/${rq._id}`, { decision: 'approve' })).status, 403);
  ok(await mgrC.call('POST', `/api/requests/${rq._id}`, { decision: 'approve' })); t('HR then Manager approval applies change');
  let d = ok(await admin.call('GET', `/api/users/${emp.user._id}`));
  assert.equal(d.user.fatherName, 'Suresh Kumar');
  assert.ok(d.versions.some((v) => v.field === 'address' && v.version === 1)); t('change applied + version history recorded');

  // Admin address correction creates versions 2
  ok(await admin.call('PATCH', `/api/users/${emp.user._id}`, { changes: { address: 'Varanasi' }, reason: 'Employee profile correction' }));
  d = ok(await admin.call('GET', `/api/users/${emp.user._id}`));
  assert.deepEqual(d.versions.filter((v) => v.field === 'address').map((v) => [v.version, v.value]).sort(), [[1, 'Gorakhpur'], [2, 'Varanasi']]); t('address v1 Gorakhpur -> v2 Varanasi');
  assert.equal((await admin.call('PATCH', `/api/users/${emp.user._id}`, { changes: { city: 'X' } })).status, 400); t('admin edit requires reason');

  // Attendance correction + void
  const att = ok(await admin.call('GET', '/api/attendance')).items[0];
  const s = att.sessions[0];
  const newOut = new Date(new Date(s.checkOut).getTime() + 30 * 60000).toISOString();
  ok(await admin.call('PATCH', `/api/attendance/${att._id}`, { sessionId: s._id, checkOut: newOut, reason: 'Verified attendance issue' })); t('admin corrected checkout');
  ok(await admin.call('DELETE', `/api/attendance/${att._id}`, { reason: 'Duplicate record' }));
  const voided = ok(await admin.call('GET', '/api/attendance')).items[0];
  assert.equal(voided.status, 'VOIDED'); assert.equal(voided.sessions.length, 3); t('void keeps the record');

  // Attendance correction request -> admin override
  const att2 = new Client(); void att2;
  const hrReq = ok(await hrC.call('POST', '/api/requests', { type: 'PROFILE_CHANGE', subjectId: emp.user._id, changes: { city: 'Varanasi' }, reason: 'HR update' })).item;
  assert.equal(hrReq.status, 'PENDING_MANAGER');
  ok(await admin.call('POST', `/api/requests/${hrReq._id}`, { decision: 'approve', note: 'Urgent, verified by Admin' })); t('admin override of pending manager stage');

  // Login by employee ID with an admin-set password; Manager requests go to Admin
  const set = ok(await admin.call('POST', '/api/users', { role: 'HR', name: 'Second HR', employeeId: 'HR-777', password: 'Handover#Pass1', manager: mgr.user._id }));
  assert.equal(set.tempPassword, null);
  ok(await new Client().call('POST', '/api/auth/login', { identifier: 'hr-777', password: 'Handover#Pass1' })); t('login by User ID (employee ID) with admin-set password');
  const mreq = ok(await mgrC.call('POST', '/api/requests', { type: 'PROFILE_CHANGE', changes: { city: 'Lucknow' }, reason: 'Moving city' })).item;
  assert.equal(mreq.status, 'PENDING_ADMIN'); t('manager request goes to Admin');
  const hrSelf = new Client(); ok(await hrSelf.call('POST', '/api/auth/login', { identifier: 'HR-777', password: 'Handover#Pass1' }));
  ok(await hrSelf.call('POST', '/api/auth/change-password', { currentPassword: 'Handover#Pass1', newPassword: 'Handover#Pass2' }));
  const hreq = ok(await hrSelf.call('POST', '/api/requests', { type: 'PROFILE_CHANGE', changes: { city: 'Delhi' }, reason: 'Moved' })).item;
  assert.equal(hreq.status, 'PENDING_MANAGER'); t('HR own request goes to their Manager');

  // COO: second in command. Manager sees everyone; Manager requests go to COO; COO requests go to Admin.
  const coo = ok(await admin.call('POST', '/api/users', { role: 'COO', employeeId: 'COO-1', name: 'Chief Ops', email: 'coo@test.local', password: 'Coo#Password1' }));
  const cooC = new Client(); ok(await cooC.call('POST', '/api/auth/login', { identifier: ' coo - 1 ', password: 'Coo#Password1' })); // employee ID: any case, stray spaces ignored
  ok(await cooC.call('POST', '/api/auth/change-password', { currentPassword: 'Coo#Password1', newPassword: 'Coo#Password2' }));
  ok(await admin.call('POST', '/api/users', { role: 'EMPLOYEE', employeeId: 'E-300', name: 'Unassigned Emp' }));
  assert.equal(ok(await mgrC.call('GET', '/api/users?q=E-300')).total, 1); t('manager sees every employee (not only assigned)');
  assert.equal(ok(await cooC.call('GET', '/api/users')).items.some((u) => u.role === 'ADMIN'), false);
  const mreq2 = ok(await mgrC.call('POST', '/api/requests', { type: 'PROFILE_CHANGE', changes: { city: 'Kanpur' }, reason: 'Moving city again' })).item;
  assert.equal(mreq2.status, 'PENDING_COO'); t('manager request goes to COO');
  assert.equal((await hrC.call('POST', `/api/requests/${mreq2._id}`, { decision: 'approve' })).status, 403);
  ok(await cooC.call('POST', `/api/requests/${mreq2._id}`, { decision: 'approve' })); t('COO approves manager request');
  const creq = ok(await cooC.call('POST', '/api/requests', { type: 'PROFILE_CHANGE', changes: { city: 'Pune' }, reason: 'COO relocating' })).item;
  assert.equal(creq.status, 'PENDING_ADMIN'); t('COO request goes to Admin');
  ok(await admin.call('POST', '/api/departments', { name: 'INTERN' }));
  const intern = ok(await admin.call('GET', '/api/departments')).items.find((d) => d.name === 'INTERN');
  ok(await admin.call('POST', '/api/departments', { name: 'INTERN - WEB DEVELOPER', parent: intern._id }));
  assert.equal(ok(await admin.call('GET', '/api/departments')).items.find((d) => d.name === 'INTERN - WEB DEVELOPER').parentName, 'INTERN'); t('sub-department under INTERN');

  // Nobody assigned above an HR: the request goes to the COO (then Admin), not straight to Admin
  const hr8 = ok(await admin.call('POST', '/api/users', { role: 'HR', employeeId: 'HR-888', name: 'HR Without Manager', password: 'Handover#Pass1' }));
  const hr8c = new Client(); ok(await hr8c.call('POST', '/api/auth/login', { identifier: 'HR-888', password: 'Handover#Pass1' }));
  ok(await hr8c.call('POST', '/api/auth/change-password', { currentPassword: 'Handover#Pass1', newPassword: 'Handover#Pass2' }));
  const hreq8 = ok(await hr8c.call('POST', '/api/requests', { type: 'PROFILE_CHANGE', changes: { city: 'Agra' }, reason: 'Moved to Agra' })).item;
  assert.equal(hreq8.status, 'PENDING_COO');
  ok(await cooC.call('POST', `/api/requests/${hreq8._id}`, { decision: 'approve' })); t('HR with no manager: request goes to the COO and applies on approval');

  // Employee may report to the COO; Admin can change a person's role (Admin-only)
  const e4 = ok(await admin.call('POST', '/api/users', { role: 'EMPLOYEE', employeeId: 'E-400', name: 'Reports To COO', manager: coo.user._id }));
  assert.equal(e4.user.manager._id ?? e4.user.manager, coo.user._id); t('employee can be assigned to a COO');
  assert.equal((await mgrC.call('PATCH', `/api/users/${e4.user._id}`, { changes: { role: 'COO' }, reason: 'try it' })).status, 403);
  assert.equal((await cooC.call('PATCH', `/api/users/${e4.user._id}`, { changes: { role: 'COO' }, reason: 'try it' })).status, 403);
  assert.equal((await admin.call('PATCH', `/api/users/${e4.user._id}`, { changes: { role: 'ADMIN' }, reason: 'nope nope' })).status, 400);
  const promoted = ok(await admin.call('PATCH', `/api/users/${e4.user._id}`, { changes: { role: 'MANAGER' }, reason: 'Promoted to manager' }));
  assert.equal(promoted.user.role, 'MANAGER'); t('admin changes role (others cannot)');

  // Dashboards work for every role
  const ad = ok(await admin.call('GET', '/api/dashboard'));
  assert.equal(ad.overview.counts.coo, 1); assert.equal(typeof ad.overview.counts.presentToday, 'number'); assert.ok(ad.overview.activity.length > 0);
  for (const c of [cooC, mgrC, hrC]) assert.ok(ok(await c.call('GET', '/api/dashboard')).overview.counts);
  assert.equal(ok(await e.call('GET', '/api/dashboard')).overview, undefined); t('dashboards for admin/COO/manager/HR/employee');

  // Per-person attendance history (monthly/daily), role-scoped
  const hist = ok(await admin.call('GET', `/api/users/${emp.user._id}/attendance`));
  assert.ok(hist.days.length >= 28 && hist.months.length >= 1); assert.equal(hist.summary.voided, 1);
  ok(await mgrC.call('GET', `/api/users/${emp.user._id}/attendance`));
  assert.equal((await e.call('GET', `/api/users/${mgr.user._id}/attendance`)).status, 404);
  assert.equal((await e.call('GET', `/api/users/${mgr.user._id}`)).status, 404); // employees can't read other profiles
  assert.equal((await e.call('GET', '/api/users/' + emp.user._id + '/attendance?month=bad')).status, 400); t('attendance history endpoint + visibility');

  // Audit trail
  const audit = ok(await admin.call('GET', '/api/audit-logs?limit=200')).items;
  const actions = new Set(audit.map((a) => a.action));
  for (const a of ['ADMIN_CREATED_MANAGER', 'ADMIN_CREATED_EMPLOYEE', 'ADMIN_UPDATED_EMPLOYEE', 'ADMIN_CORRECTED_ATTENDANCE', 'ADMIN_VOIDED_ATTENDANCE', 'ADMIN_OVERRIDE', 'ADMIN_LOGIN', 'ADMIN_LOGIN_FAILED', 'ADMIN_CREATED_LOCATION'])
    assert.ok(actions.has(a), `missing audit action ${a}`);
  const corr = audit.find((a) => a.action === 'ADMIN_CORRECTED_ATTENDANCE');
  assert.ok(corr.oldData.checkOut && corr.newData.checkOut && corr.reason && corr.ip !== undefined && corr.requestId); t('audit entries with old/new/reason/requestId');

  // Deactivate / delete keep history; archived user can't log in
  ok(await admin.call('DELETE', `/api/users/${emp.user._id}`, { reason: 'Left the company' }));
  assert.equal((await new Client().call('POST', '/api/auth/login', { identifier: 'rahul@example.com', password: 'Employee#Pass1' })).status, 401);
  assert.equal(ok(await admin.call('GET', '/api/attendance')).items.length, 1); t('deleted = archived: login blocked, history kept');
  assert.equal((await admin.call('DELETE', `/api/users/${emp.user._id}`, {})).status, 400); t('delete requires reason');

  // CSV import with partial failures
  const csv = 'Employee ID,Name,Email,Department\nE-201,Asha Rao,asha@example.com,Support\nE-202,NoContact,,Sales\nE-203,Bad Email,not-an-email,Sales\n,No ID,,Sales\n';
  const imp = ok(await admin.call('POST', '/api/users/import', { csv }));
  assert.equal(imp.imported, 2); assert.equal(imp.failed, 2); t('import: valid rows in, invalid rows reported');

  // Audit immutability
  const { default: mongoose } = await import('mongoose');
  await mongoose.connect(env.MONGODB_URI);
  const AuditLog = (await import('../src/models/AuditLog.js')).default;
  await assert.rejects(() => AuditLog.updateOne({}, { reason: 'x' }));
  await assert.rejects(() => AuditLog.deleteMany({}));
  await mongoose.disconnect(); t('audit log rejects update/delete');

  // ---------- Emails (role-wise), checked against what the local SMTP server received ----------
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  await wait(2500);
  const welcome = mailsTo('rahul@example.com').find((m) => /Welcome/.test(m.subject));
  assert.ok(welcome && welcome.text.includes('E-101') && welcome.text.includes(emp.tempPassword) && welcome.html.includes('<table'), 'welcome email with user id + password');
  assert.ok(mailsTo('coo@test.local').some((m) => /Welcome/.test(m.subject) && m.text.includes('Coo#Password1')), 'COO welcome with the admin-set password'); t('new account: welcome email with user ID + password + template');
  assert.ok(has('rahul@example.com', /Checked in (late )?at/) && has('rahul@example.com', /Checked out at/), 'employee check-in / check-out mails');
  assert.ok(has('rahul@example.com', /Still in office/), 'still-in-office mail'); assert.ok(has('rahul@example.com', /Checked in late at/), 'late check-in email'); t('employee gets check-in (late), check-out and "Still in office?" emails');
  assert.ok(has('admin-inbox@test.local', /Attendance corrected/) && has('admin-inbox@test.local', /Attendance voided/), 'attendance correction mails to admin');
  assert.ok(!has('rahul@example.com', /was corrected|was voided/), 'employee gets no correction mail'); t('attendance corrected/voided: admin emailed, employee not');
  assert.ok(has('amit@example.com', /Approval needed/), 'approver (manager) mail');
  assert.ok(has('admin-inbox@test.local', /Approved: profile change/), 'approved mail to admin');
  assert.ok(!has('rahul@example.com', /request was submitted|Approved:|Rejected:/), 'employee gets no request mails'); t('requests: approval-needed (approver) + outcome (admin); employee gets none');
  const kinds = new Set(mailsTo('rahul@example.com').map((m) => (/Welcome/.test(m.subject) ? 'welcome' : /Checked (in|out)|Still in office/.test(m.subject) ? 'attendance' : m.subject)));
  assert.deepEqual([...kinds].sort(), ['attendance', 'welcome']); t('employee mailbox: only welcome + check-in/check-out mails');
  assert.ok(has('coo@test.local', /Approval needed|Approved|Attendance|Profile updated/), 'COO gets approvals/changes');
  assert.ok(has('admin-inbox@test.local', /Profile updated: Rahul/) && !has('rahul@example.com', /Your details were updated/), 'direct edit mails'); t('direct profile edit: admin emailed, employee not');
  const nobody = outbox.filter((m) => m.to.includes('admin@shineinfo.in'));
  assert.equal(nobody.length, 0, 'the placeholder admin login email must not receive alerts when a notification email is set'); t('admin alerts go to the Notification email only');

  // Daily tasks: HR assigns, employee sees, HR updates in the evening (Rahul was archived above, so a new employee)
  const pv = ok(await admin.call('POST', '/api/users', { role: 'EMPLOYEE', employeeId: 'E-500', name: 'Priya Verma', email: 'priya@example.com', department: dept._id, hr: hr.user._id, location: loc._id, password: 'Priya#Pass500' }));
  const pe = new Client();
  if (ok(await pe.call('POST', '/api/auth/login', { identifier: 'priya@example.com', password: 'Priya#Pass500' })).mustChangePassword) ok(await pe.call('POST', '/api/auth/change-password', { currentPassword: 'Priya#Pass500', newPassword: 'Priya#Pass501' }));
  // Authority Admin > COO > Manager > HR: a COO (or the Manager) can decide a request that is still waiting for HR
  const rqC = ok(await pe.call('POST', '/api/requests', { type: 'PROFILE_CHANGE', changes: { city: 'Lucknow' }, reason: 'Moved to a new city' })).item;
  assert.equal(rqC.status, 'PENDING_HR');
  assert.ok(ok(await cooC.call('GET', '/api/requests?pending=1')).items.find((x) => x._id === rqC._id).canAct, 'COO sees Approve on an HR-stage request');
  const decided = ok(await cooC.call('POST', `/api/requests/${rqC._id}`, { decision: 'approve' })).item;
  assert.equal(decided.status, 'APPROVED'); assert.equal(decided.history.at(-1).override, true);
  assert.equal(ok(await admin.call('GET', `/api/users/${pv.user._id}`)).user.city, 'Lucknow');
  const rqM = ok(await pe.call('POST', '/api/requests', { type: 'PROFILE_CHANGE', changes: { state: 'Uttar Pradesh' }, reason: 'Adding my state' })).item;
  assert.equal(ok(await mgrC.call('POST', `/api/requests/${rqM._id}`, { decision: 'approve' })).item.status, 'APPROVED'); t('COO and Manager can approve a request waiting for HR (final, logged as override)');
  const tk1 = ok(await hrC.call('POST', '/api/tasks', { userId: pv.user._id, title: 'Call 20 leads', details: 'Gorakhpur list' })).task;
  const tk2 = ok(await hrC.call('POST', '/api/tasks', { userId: pv.user._id, title: 'Send quotation to ABC' })).task;
  assert.equal((await hrC.call('POST', '/api/tasks', { userId: pv.user._id, title: 'x' })).status, 400);
  assert.equal((await hrC.call('POST', '/api/tasks', { userId: pv.user._id, title: 'Past task', date: '2020-01-01' })).status, 400);
  assert.equal((await pe.call('POST', '/api/tasks', { userId: pv.user._id, title: 'Self task' })).status, 403); t('HR assigns daily tasks; employees cannot');
  // Bell: welcome on onboarding + task assigned; reading clears them
  await wait(800);
  const bell = ok(await pe.call('GET', '/api/notifications'));
  assert.ok(bell.items.some((n) => /Welcome to Shine Infosolutions/.test(n.title)), 'welcome notification');
  assert.ok(bell.items.some((n) => /New task assigned/.test(n.title)), 'task notification');
  ok(await pe.call('POST', '/api/notifications', { id: bell.items[0]._id }));
  assert.equal(ok(await pe.call('GET', '/api/notifications')).count, bell.count - 1);
  ok(await pe.call('POST', '/api/notifications', { all: true }));
  assert.equal(ok(await pe.call('GET', '/api/notifications')).count, 0);
  assert.equal(ok(await hrC.call('GET', '/api/notifications')).items.some((n) => /New task assigned/.test(n.title)), false); t('notification bell: welcome + task for the employee only; read clears');
  // Custom notifications: Admin / COO / Manager / HR to the people they oversee
  assert.equal((await pe.call('PUT', '/api/notifications', { title: 'Hello all', body: 'From an employee', to: 'all' })).status, 403);
  assert.equal((await hrC.call('PUT', '/api/notifications', { title: 'Hi', body: 'x', to: 'all' })).status, 400);
  assert.equal((await hrC.call('PUT', '/api/notifications', { title: 'Not mine', body: 'Should not arrive', to: [String(coo.user._id)] })).status, 400);
  assert.equal(ok(await hrC.call('PUT', '/api/notifications', { title: 'Office closed Monday', body: 'Diwali holiday.', to: [String(pv.user._id)] })).sent, 1);
  assert.ok(ok(await admin.call('PUT', '/api/notifications', { title: 'Town hall at 4 PM', body: 'Everyone please join.', to: 'all' })).sent >= 3);
  await wait(800);
  const custom = ok(await pe.call('GET', '/api/notifications')).items;
  assert.ok(custom.some((n) => n.title === 'Office closed Monday' && /Hina HR \(HR\)/.test(n.body)) && custom.some((n) => n.title === 'Town hall at 4 PM')); t('custom notifications: staff roles only, only to people they oversee');
  // A person added today has no attendance history before today ("no data", not "absent")
  const h0 = ok(await pe.call('GET', `/api/users/${pv.user._id}/attendance`));
  assert.equal(h0.months.length, 1); assert.equal(h0.start, h0.today); assert.ok(h0.days.filter((x) => x.date < h0.today).every((x) => x.status === 'BEFORE_START')); t('history starts on the onboarding day');
  const mine = ok(await pe.call('GET', '/api/tasks?mine=1'));
  assert.equal(mine.tasks.length, 2); assert.equal(mine.canAssign, false); assert.equal(mine.people, undefined); t('employee sees own tasks');
  // The assignee writes their own update first; only then does HR approve
  assert.deepEqual(taskPoints('- Call the leads\n2. Note who is interested\n\n• Share the summary'), ['Call the leads', 'Note who is interested', 'Share the summary']);
  assert.equal((await hrC.call('POST', `/api/tasks/${tk1._id}/update`, { text: 'Not my task', done: true })).status, 404);
  assert.equal((await pe.call('POST', `/api/tasks/${tk1._id}/update`, { text: 'x', done: true })).status, 400);
  const upd = ok(await pe.call('POST', `/api/tasks/${tk1._id}/update`, { text: 'Called all 20, 6 are interested', done: true })).task;
  assert.equal(upd.status, 'SUBMITTED'); assert.equal(upd.update.done, true);
  assert.equal(ok(await hrC.call('GET', '/api/tasks')).tasks.find((x) => x._id === tk1._id).label, 'Waiting for approval');
  await wait(600);
  assert.ok(ok(await hrC.call('GET', '/api/notifications')).items.some((n) => /Task update from Priya Verma/.test(n.title))); t('assignee submits an update; HR is told and sees it waiting for approval');
  assert.equal((await pe.call('PATCH', `/api/tasks/${tk1._id}`, { status: 'DONE' })).status, 403);
  const done = ok(await hrC.call('PATCH', `/api/tasks/${tk1._id}`, { status: 'DONE', note: 'All 20 called' })).task;
  assert.equal(done.late, false); assert.equal(done.status, 'DONE');
  assert.equal((await pe.call('POST', `/api/tasks/${tk1._id}/update`, { text: 'Changing my update', done: false })).status, 400); t('HR approves the update the same day (scores 1); it is then locked');
  // Move a task to another person: it starts again for them, both are told; a reviewed task cannot be moved
  const other = ok(await admin.call('POST', '/api/users', { role: 'EMPLOYEE', employeeId: 'E-501', name: 'Karan Mehta', department: dept._id, hr: hr.user._id }));
  const tk3 = ok(await hrC.call('POST', '/api/tasks', { userId: pv.user._id, title: 'Prepare the client list' })).task;
  ok(await pe.call('POST', `/api/tasks/${tk3._id}/update`, { text: 'Half done', done: false }));
  const movedTask = ok(await hrC.call('PATCH', `/api/tasks/${tk3._id}`, { userId: other.user._id })).task;
  assert.equal(String(movedTask.user), String(other.user._id)); assert.equal(movedTask.status, 'PENDING'); assert.equal(movedTask.update, undefined);
  assert.equal(ok(await pe.call('GET', '/api/tasks?mine=1')).tasks.some((x) => x._id === tk3._id), false);
  assert.equal((await hrC.call('PATCH', `/api/tasks/${tk1._id}`, { userId: other.user._id })).status, 400);
  assert.equal((await hrC.call('PATCH', `/api/tasks/${tk3._id}`, { userId: String(coo.user._id) })).status, 403);
  await wait(600);
  assert.ok(ok(await pe.call('GET', '/api/notifications')).items.some((n) => /Task moved to someone else/.test(n.title))); t('a task can be moved to another person');
  const team = ok(await hrC.call('GET', '/api/tasks'));
  assert.ok(team.people.some((p) => p._id === pv.user._id)); assert.equal(team.tasks.length, 3); t('HR sees the team tasks and assignable people');

  // CRM (WhatsApp): Admin + COO only; nothing can be sent until it is connected
  assert.equal((await hrC.call('GET', '/api/crm')).status, 403); assert.equal((await pe.call('GET', '/api/crm')).status, 403);
  const crm = ok(await cooC.call('GET', '/api/crm'));
  assert.equal(crm.configured, false); assert.equal(crm.hasToken, false); assert.ok(crm.presets.some((p) => p.name === 'interview_invite')); assert.ok(crm.employees.length > 0);
  assert.equal((await admin.call('POST', '/api/crm/send', { template: 'interview_invite', recipients: [{ name: 'A', phone: '9876543210', params: ['A'] }] })).status, 400);
  assert.equal((await admin.call('POST', '/api/crm/config', { phoneId: 'abc', businessId: '123', token: 'x' })).status, 400);
  assert.deepEqual(['98765 43210', '09876543210', '+91 98765-43210', '+1 (555) 640-9971', '12345'].map(normalizePhone), ['919876543210', '919876543210', '919876543210', '15556409971', null]); t('CRM: Admin + COO only, needs a WhatsApp connection, phone numbers normalised');
  // Connect (checked against the API), list templates, bulk send with per-person values, failures logged
  assert.equal((await cooC.call('POST', '/api/crm/config', { phoneId: wa.phoneId, businessId: wa.businessId, token: 'w'.repeat(60) })).status, 400);
  assert.equal(ok(await cooC.call('POST', '/api/crm/config', { phoneId: wa.phoneId, businessId: wa.businessId, token: wa.token })).account.number, '+91 90000 11111');
  const crm2 = ok(await cooC.call('GET', '/api/crm'));
  assert.equal(crm2.configured, true); assert.equal(crm2.account.test, false); assert.equal(JSON.stringify(crm2).includes(wa.token), false, 'token never sent to the browser');
  assert.deepEqual(crm2.templates.filter((x) => x.usable).map((x) => x.name), ['employee_welcome', 'interview_invite']);
  assert.equal(crm2.templates.find((x) => x.name === 'interview_invite').vars, 5);
  const inv = ok(await cooC.call('POST', '/api/crm/send', { template: 'interview_invite', language: 'en', purpose: 'INTERVIEW', recipients: [
    { name: 'Rahul Kumar', phone: '98765 43210', params: ['Rahul', 'Sales Executive', '10 October', '11:00 AM', 'Office,\nGorakhpur'] },
    { name: 'Blocked', phone: '9000000000', params: ['Blocked', 'Sales Executive', '10 October', '11:00 AM', 'Office'] },
    { name: 'No number', phone: '12', params: [] }] }));
  assert.deepEqual([inv.sent, inv.failed], [1, 2]); assert.match(inv.results[1].error, /allowed list/); assert.match(inv.results[2].error, /valid mobile/);
  assert.equal(wa.sent.length, 1); assert.equal(wa.sent[0].to, '919876543210'); assert.equal(wa.sent[0].template.name, 'interview_invite');
  assert.deepEqual(wa.sent[0].template.components[0].parameters.map((p) => p.text), ['Rahul', 'Sales Executive', '10 October', '11:00 AM', 'Office, Gorakhpur']);
  assert.equal(ok(await cooC.call('GET', '/api/crm')).history.length, 3);
  assert.equal(ok(await cooC.call('POST', '/api/crm/templates', { preset: 'team_update' })).status, 'PENDING'); t('CRM: connect, templates, bulk send (sent + failed logged), template submission');

  // Scheduled jobs
  assert.equal((await admin.call('GET', '/api/cron/daily-report')).status, 401); t('cron endpoints reject requests without the secret');
  const cronCall = async (path) => { const res = await fetch(BASE + path, { headers: { authorization: 'Bearer cron-secret-for-tests' } }); return { status: res.status, data: await res.json() }; };
  assert.ok(ok(await cronCall('/api/cron/end-of-day')).skipped, 'office still open => nothing closed');
  ok(await pe.call('POST', '/api/attendance/check-in', { lat: 26.7607, lng: 83.3733, accuracy: 5, lateReason: 'Doctor appointment' }));
  // One task still has no update: checking out is refused until it does
  const early = await pe.call('POST', '/api/attendance/check-out', {});
  assert.equal(early.status, 400); assert.equal(early.data.code, 'TASK_UPDATE_REQUIRED'); assert.equal(ok(await pe.call('GET', '/api/dashboard')).today.tasksPending, 1); t('check-out needs an update on every task of the day');
  // A phone that stops reporting: the person is asked, never checked out. With no reply the record needs a review.
  const before = ok(await pe.call('GET', '/api/dashboard')).today.record.sessions.at(-1);
  assert.ok(before.lastPingAt, 'check-in counts as a location report');
  assert.deepEqual(ok(await cronCall('/api/cron/silent-check')), { asked: 1, escalated: 0 });
  let peDay = ok(await pe.call('GET', '/api/dashboard')).today;
  assert.equal(peDay.checkedIn, true); assert.equal(peDay.presence.status, 'ASKED'); assert.equal(peDay.presence.reason, 'SIGNAL_LOST');
  await wait(600);
  assert.ok(ok(await pe.call('GET', '/api/notifications')).items.some((n) => n.title === 'Still in office?'));
  // the location coming back inside settles it without anyone doing anything
  assert.equal(ok(await pe.call('POST', '/api/attendance/ping', { lat: 26.7607, lng: 83.3733, accuracy: 5 })).check, null);
  assert.equal(ok(await pe.call('GET', '/api/dashboard')).today.record.sessions.at(-1).checks[0].outcome, 'SIGNAL_RESTORED'); t('signal lost => asked; location back inside settles it');
  // asked again, no reply => review required; the HR of that person is told and decides
  assert.equal(ok(await cronCall('/api/cron/silent-check')).asked, 1);
  assert.deepEqual(ok(await cronCall('/api/cron/silent-check')), { asked: 0, escalated: 1 });
  peDay = ok(await pe.call('GET', '/api/dashboard')).today;
  assert.equal(peDay.checkedIn, true); assert.equal(peDay.presence.status, 'REVIEW_REQUIRED');
  assert.equal((await pe.call('POST', '/api/attendance/presence', { answer: 'IN_OFFICE' })).status, 409);
  await wait(600);
  assert.ok(ok(await hrC.call('GET', '/api/notifications')).items.some((n) => /Attendance review needed: Priya Verma/.test(n.title)));
  const hrQueue = ok(await hrC.call('GET', '/api/attendance?review=1')).items;
  const peRec = hrQueue.find((r) => r.user._id === pv.user._id);
  assert.equal(peRec.canReview, true);
  const peCheck = peRec.sessions.at(-1).checks.find((k) => k.status === 'REVIEW_REQUIRED');
  ok(await hrC.call('POST', `/api/attendance/${peRec._id}/review`, { checkId: peCheck._id, decision: 'STAYED', note: 'She was at her desk, phone battery saver' }));
  assert.equal(ok(await pe.call('GET', '/api/dashboard')).today.checkedIn, true);
  assert.equal(ok(await hrC.call('GET', '/api/dashboard')).overview.attention.reviewNeeded, 0); t('no reply => review required; HR reviews, the session was never closed');
  // Android app: its background service reports location with its own token (no login cookie)
  const trackToken = ok(await pe.call('POST', '/api/attendance/track-token')).token;
  const track = async (token, body) => { const res = await fetch(BASE + '/api/attendance/track', { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer ' + token }, body: JSON.stringify(body) }); return { status: res.status, data: await res.json() }; };
  assert.equal((await track('not-a-real-token-not-a-real-token', { lat: 26.7607, lng: 83.3733 })).status, 401);
  assert.equal(ok(await track(trackToken, { lat: 26.7607, lng: 83.3733, accuracy: 5 })).open, true);
  const oldToken = trackToken, newToken = ok(await pe.call('POST', '/api/attendance/track-token')).token;
  assert.equal((await track(oldToken, {})).status, 401); assert.equal(ok(await track(newToken, {})).open, true); t('app background service: token-only location reports; a new token replaces the old one');
  ok(await admin.call('PATCH', '/api/settings', { workStart: '00:00', workEnd: '00:01', reason: 'Simulate office closing' }));
  assert.equal(ok(await cronCall('/api/cron/end-of-day')).closed, 1);
  assert.equal(ok(await pe.call('GET', '/api/dashboard')).today.checkedIn, false);
  assert.equal((await pe.call('POST', '/api/attendance/check-in', { lat: 26.7607, lng: 83.3733, accuracy: 5, reason: 'Late work' })).status, 403); t('after office hours: everyone checked out, check-in closed');
  const rep = ok(await cronCall('/api/cron/daily-report'));
  assert.equal(rep.tasks.finalized, 2); assert.ok(rep.report.present >= 1);
  const late = ok(await pe.call('GET', '/api/tasks?mine=1')).tasks.find((x) => x._id === tk2._id);
  assert.equal(late.status, 'NOT_DONE'); assert.equal(late.label, 'Late submission'); assert.equal(late.score, 0); t('un-updated task becomes a late submission (score 0)');
  await wait(2000);
  const report = mailsTo('report@test.local').find((m) => /Attendance report/.test(m.subject));
  assert.ok(report && report.html.includes('Priya Verma') && report.html.includes('Call 20 leads') && report.html.includes('Late submission'), 'detailed report');
  assert.ok(has('priya@example.com', /office closing/), 'end-of-day check-out mail');
  assert.ok(mailsTo('priya@example.com').some((m) => /^New task for .*Call 20 leads/.test(m.subject) && m.text.includes('Gorakhpur list')), 'task assignment email');
  assert.equal(outbox.filter((m) => /Attendance report|Attendance summary|Absent so far/.test(m.subject) && !m.to.includes('report@test.local')).length, 0, 'report goes nowhere else');
  t('evening report (attendance + tasks) goes only to the report address');

  // Security: lock an account
  for (let i = 0; i < 5; i++) await new Client().call('POST', '/api/auth/login', { identifier: 'amit@example.com', password: 'wrong-password' });
  await wait(2000);
  assert.ok(has('admin-inbox@test.local', /Account locked/) && !has('amit@example.com', /account was locked/), 'lockout mails'); t('locked account: admin emailed');

  console.log(`\nAll ${step} checks passed.`);
} catch (e) {
  console.error('\nFAILED:', e.message);
  process.exitCode = 1;
} finally {
  await cleanup();
}
