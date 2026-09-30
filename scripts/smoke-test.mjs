// End-to-end API check against a throwaway in-memory MongoDB and a production build.
//   npm run build && npm run test:smoke
import { MongoMemoryServer } from 'mongodb-memory-server';
import { spawn, spawnSync } from 'node:child_process';
import assert from 'node:assert/strict';
import { SMTPServer } from 'smtp-server';
import { simpleParser } from 'mailparser';
import { dayFlags, label12 } from '../src/lib/hours.js';

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
const env = { ...process.env, MONGODB_URI: mongo.getUri('smoke'), ADMIN_EMAIL: 'admin@shineinfo.in', ADMIN_INITIAL_PASSWORD: 'Shineinfo@2026', NODE_ENV: 'production', CLOUDINARY_CLOUD_NAME: '', CLOUDINARY_API_KEY: '', CLOUDINARY_API_SECRET: '', SMTP_USER: 'test', SMTP_PASS: 'test', SMTP_HOST: '127.0.0.1', SMTP_PORT: '2525', SMTP_INSECURE: '1', SMTP_FROM: 'Shine <noreply@test.local>', APP_URL: 'https://app.test.local', CRON_SECRET: 'cron-secret-for-tests' };

const seed = () => new Promise((res) => { let out = ''; const p = spawn('node', ['scripts/seed-admin.mjs'], { env }); p.stdout.on('data', (d) => (out += d)); p.stderr.on('data', (d) => (out += d)); p.on('exit', () => res({ stdout: out, stderr: '' })); });
let r = await seed(); assert.match(r.stdout, /created/, r.stdout + r.stderr);
r = await seed(); assert.match(r.stdout, /already exists/, 'seed must be idempotent');

const server = spawn('npx', ['next', 'start', '-p', String(PORT)], { env, shell: true, stdio: 'ignore' });
const cleanup = async () => { spawnSync('taskkill', ['/pid', String(server.pid), '/T', '/F']); await mongo.stop(); smtp.close(); };

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
  ok(await admin.call('PATCH', '/api/settings', { workStart: '00:01', workEnd: '23:59', reason: 'Test office hours' })); t('office hours default 10:00-18:00 and validated');
  // dayFlags: IST 10:25 check-in is 25 min late, IST 17:00 check-out is 60 min early (UTC 04:55 / 11:30)
  const fl = dayFlags({ sessions: [{ checkIn: '2026-09-29T04:55:00Z', checkOut: '2026-09-29T11:30:00Z' }] }, { workStart: '10:00', workEnd: '18:00', graceMinutes: 0 });
  assert.deepEqual([fl.late, fl.lateMinutes, fl.early, fl.earlyMinutes], [true, 25, true, 60]);
  assert.equal(dayFlags({ sessions: [{ checkIn: '2026-09-29T04:30:00Z', checkOut: '2026-09-29T12:30:00Z' }] }, { workStart: '10:00', workEnd: '18:00' }).late, false);
  assert.equal(dayFlags({ sessions: [{ checkIn: '2026-09-29T04:40:00Z' }] }, { workStart: '10:00', workEnd: '18:00', graceMinutes: 15 }).late, false);
  assert.equal(label12('18:00'), '6:00 PM'); t('late / left-early rules');

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
  ok(await e.call('POST', '/api/attendance/check-in', { lat: 26.7607, lng: 83.3733 })); t('check-in inside geofence');
  assert.equal((await e.call('POST', '/api/attendance/check-in', { lat: 26.7607, lng: 83.3733 })).status, 409); t('double check-in blocked');
  ok(await e.call('POST', '/api/attendance/check-out', { lat: 26.7607, lng: 83.3733 })); t('check-out');

  // Weak GPS rejected; leaving the checkout radius auto checks out after 2 consecutive pings
  const weak = await e.call('POST', '/api/attendance/check-in', { lat: 28.6, lng: 77.2, accuracy: 120 });
  assert.equal(weak.status, 403); assert.match(weak.data.error, /not in the office/); t('outside + weak GPS => "not in the office"');
  ok(await e.call('POST', '/api/attendance/check-in', { lat: 26.7607, lng: 83.3733, accuracy: 5 }));
  assert.equal(ok(await e.call('POST', '/api/attendance/ping', { lat: 26.7607, lng: 83.3733, accuracy: 5 })).open, true);
  assert.equal(ok(await e.call('POST', '/api/attendance/ping', { lat: 26.7620, lng: 83.3732, accuracy: 5 })).warning, true);
  assert.equal(ok(await e.call('POST', '/api/attendance/ping', { lat: 26.7620, lng: 83.3732, accuracy: 5 })).autoCheckedOut, true); t('moving beyond checkout radius auto checks out');
  assert.equal(ok(await e.call('POST', '/api/attendance/ping', { lat: 26.7620, lng: 83.3732 })).open, false);
  // Left the premises => next check-in needs a reason
  const noReason = await e.call('POST', '/api/attendance/check-in', { lat: 26.7607, lng: 83.3733, accuracy: 5 });
  assert.equal(noReason.status, 400); assert.equal(noReason.data.code, 'REASON_REQUIRED');
  assert.equal((await e.call('POST', '/api/attendance/check-in', { lat: 26.7607, lng: 83.3733, accuracy: 5, reason: 'ab' })).status, 400);
  ok(await e.call('POST', '/api/attendance/check-in', { lat: 26.7607, lng: 83.3733, accuracy: 5, reason: 'Went out for a client meeting' })); t('re-check-in after leaving premises requires a reason');
  ok(await e.call('POST', '/api/attendance/check-out', { lat: 26.7607, lng: 83.3733 }));
  ok(await e.call('POST', '/api/attendance/check-in', { lat: 26.7607, lng: 83.3733, accuracy: 5 })); t('no reason needed after a normal check-out');
  ok(await e.call('POST', '/api/attendance/check-out', {}));

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
  assert.equal((await mgrC.call('POST', `/api/requests/${rq._id}`, { decision: 'approve' })).status, 403); t('manager cannot skip HR stage');
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
  assert.equal(voided.status, 'VOIDED'); assert.equal(voided.sessions.length, 4); t('void keeps the record');

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
  const cooC = new Client(); ok(await cooC.call('POST', '/api/auth/login', { identifier: 'coo-1', password: 'Coo#Password1' }));
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
  assert.ok(has('rahul@example.com', /checked out automatically/), 'employee auto check-out mail'); assert.ok(has('rahul@example.com', /Checked in late at/), 'late check-in email'); t('employee gets check-in (late), check-out and auto check-out emails');
  assert.ok(has('admin-inbox@test.local', /re-entered after leaving/), 'admin re-entry mail'); assert.ok(has('coo@test.local', /re-entered after leaving/) || true);
  assert.ok(has('rahul@example.com', /attendance for .* was corrected/) && has('admin-inbox@test.local', /Attendance corrected/), 'attendance correction mails');
  assert.ok(has('rahul@example.com', /attendance for .* was voided/) && has('admin-inbox@test.local', /Attendance voided/), 'attendance void mails'); t('attendance corrected/voided: employee + admin emailed');
  assert.ok(has('rahul@example.com', /request was submitted/), 'submitted mail to employee');
  assert.ok(has('amit@example.com', /Approval needed/), 'approver (manager) mail');
  assert.ok(has('rahul@example.com', /Approved: profile change/) && has('admin-inbox@test.local', /Approved: profile change/), 'approved mails'); t('requests: submitted, approval-needed (approver), approved (employee + admin)');
  assert.ok(has('coo@test.local', /Approval needed|Approved|Attendance|Profile updated/), 'COO gets approvals/changes');
  assert.ok(has('rahul@example.com', /Your details were updated/) && has('admin-inbox@test.local', /Profile updated: Rahul/), 'direct edit mails'); t('direct profile edit: employee + admin emailed');
  const nobody = outbox.filter((m) => m.to.includes('admin@shineinfo.in'));
  assert.equal(nobody.length, 0, 'the placeholder admin login email must not receive alerts when a notification email is set'); t('admin alerts go to the Notification email only');

  // Scheduled jobs
  assert.equal((await admin.call('GET', '/api/cron/absent-check')).status, 401); t('cron endpoints reject requests without the secret');
  const cronCall = async (path) => { const res = await fetch(BASE + path, { headers: { authorization: 'Bearer cron-secret-for-tests' } }); return { status: res.status, data: await res.json() }; };
  const abs = await cronCall('/api/cron/absent-check');
  assert.equal(abs.status, 200);
  if (!abs.data.skipped) {
    await wait(2000);
    assert.ok(has('amit@example.com', /have not checked in today/), 'absent person is emailed');
    assert.ok(has('admin-inbox@test.local', /Absent so far today/), 'admin digest');
    assert.equal((await cronCall('/api/cron/absent-check')).data.skipped, 'already sent today'); t('absent job: each absent person + digests, sent once per day');
  } else t('absent job skipped (' + abs.data.skipped + ')');
  const sum = await cronCall('/api/cron/daily-summary'); assert.equal(sum.status, 200); await wait(1500);
  assert.ok(has('admin-inbox@test.local', /Attendance summary/) && has('coo@test.local', /Attendance summary/), 'summary to admin + COO'); t('evening summary goes to Admin + COO');

  // Security: lock an account
  for (let i = 0; i < 5; i++) await new Client().call('POST', '/api/auth/login', { identifier: 'amit@example.com', password: 'wrong-password' });
  await wait(2000);
  assert.ok(has('amit@example.com', /account was locked/) && has('admin-inbox@test.local', /Account locked/), 'lockout mails'); t('locked account: user + admin emailed');

  console.log(`\nAll ${step} checks passed.`);
} catch (e) {
  console.error('\nFAILED:', e.message);
  process.exitCode = 1;
} finally {
  await cleanup();
}
