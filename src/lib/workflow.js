import { M } from './db.js';
import { audit } from './audit.js';
import { bad, forbidden, notFound, requireReason, HttpError } from './http.js';
import { applyUserChanges, canManage, normalizeChanges } from './users.js';
import { correctAttendance } from './attendance.js';
import { notifyPending, notifyDecision, notifySubmitted } from './notify.js';
import { EMPLOYEE_REQUESTABLE, PROFILE_FIELDS } from './constants.js';

const activeUser = (id) => (id ? M.User.findOne({ _id: id, status: 'ACTIVE' }).lean() : null);

async function firstStage(requester, subject, from) {
  // EMPLOYEE -> HR -> MANAGER -> apply; HR -> MANAGER -> apply. Missing/inactive stages are skipped;
  // with nobody left the request waits for Admin.
  if (from === 'COO') return 'PENDING_ADMIN'; // COO -> Admin
  if (from === 'MANAGER') return (await M.User.exists({ role: 'COO', status: 'ACTIVE' })) ? 'PENDING_COO' : 'PENDING_ADMIN'; // Manager -> COO -> Admin
  if (from === 'EMPLOYEE' && (await activeUser(subject.hr))) return 'PENDING_HR';
  if (await activeUser(subject.manager)) return 'PENDING_MANAGER';
  return 'PENDING_ADMIN';
}

export async function createRequest(ctx, { type, subjectId, changes, payload, reason }) {
  const actor = ctx.user;
  if (!['EMPLOYEE', 'HR', 'MANAGER', 'COO'].includes(actor.role)) throw forbidden('Admin changes data directly');
  reason = requireReason(reason);
  const subject = await M.User.findById(actor.role === 'EMPLOYEE' || !subjectId ? actor._id : subjectId).lean();
  if (!subject) throw notFound('Employee not found');
  const self = String(subject._id) === String(actor._id);
  if (actor.role !== 'EMPLOYEE' && !self && !canManage(actor, subject)) throw forbidden('This person is not assigned to you');

  let data = {};
  if (type === 'PROFILE_CHANGE') {
    if (!changes || !Object.keys(changes).length) throw bad('No changes supplied');
    const allowed = self ? EMPLOYEE_REQUESTABLE : PROFILE_FIELDS;
    data = { changes: normalizeChanges(changes, allowed) };
  } else if (type === 'ATTENDANCE_CORRECTION') {
    if (!payload?.attendanceId) throw bad('attendanceId is required');
    const rec = await M.Attendance.findById(payload.attendanceId).lean();
    if (!rec || String(rec.user) !== String(subject._id)) throw notFound('Attendance record not found');
    data = { payload: { attendanceId: payload.attendanceId, sessionId: payload.sessionId, checkIn: payload.checkIn, checkOut: payload.checkOut } };
  } else throw bad('Unknown request type');

  const status = await firstStage(actor, subject, actor.role);
  const r = await M.ChangeRequest.create({
    type, requester: actor._id, subject: subject._id, reason, status, ...data,
    history: [{ by: actor._id, byRole: actor.role, action: 'SUBMITTED', note: reason }],
  });
  await audit(ctx, {
    action: 'SUBMITTED_REQUEST', entityType: 'ChangeRequest', entityId: r._id, subjectId: subject._id,
    department: subject.department, location: subject.location, newData: { type, ...data, status }, reason,
  });
  notifySubmitted(r._id);
  notifyPending(r._id);
  return r;
}

/** Which requests can this user act on right now? */
export function canActOn(actor, r, subject) {
  if (['APPROVED', 'REJECTED'].includes(r.status)) return false;
  if (String(r.requester) === String(actor._id) && actor.role !== 'ADMIN') return false;
  if (actor.role === 'ADMIN') return true;
  if (actor.role === 'HR') return r.status === 'PENDING_HR' && String(subject?.hr) === String(actor._id);
  if (actor.role === 'MANAGER') return r.status === 'PENDING_MANAGER' && String(subject?.manager) === String(actor._id);
  if (actor.role === 'COO') return ['PENDING_COO', 'PENDING_MANAGER'].includes(r.status);
  return false;
}

async function apply(ctx, r, actor, override, note) {
  if (r.type === 'PROFILE_CHANGE') {
    await applyUserChanges(ctx, { userId: r.subject, changes: r.changes, reason: `Approved request: ${r.reason}`, actor, override, silent: true });
  } else {
    const p = r.payload || {};
    await correctAttendance(ctx, { attendanceId: p.attendanceId, sessionId: p.sessionId, checkIn: p.checkIn, checkOut: p.checkOut,
      reason: `Approved request: ${r.reason}`, override, actor });
  }
}

export async function reviewRequest(ctx, id, { decision, note }) {
  const actor = ctx.user;
  const r = await M.ChangeRequest.findById(id);
  if (!r) throw notFound('Request not found');
  const subject = await M.User.findById(r.subject).lean();
  if (!canActOn(actor, r, subject)) throw forbidden('This request is not waiting for you');
  if (!['approve', 'reject'].includes(decision)) throw bad('Decision must be approve or reject');
  if (decision === 'reject') note = requireReason(note, 3);

  // Admin acting on a stage that belongs to someone else is an override.
  const override = actor.role === 'ADMIN' && r.status !== 'PENDING_ADMIN';
  if (override) note = requireReason(note, 5);

  const before = r.status;
  if (decision === 'reject') {
    r.status = 'REJECTED';
  } else if (actor.role === 'HR' && r.status === 'PENDING_HR') {
    r.status = (await activeUser(subject.manager)) ? 'PENDING_MANAGER' : 'PENDING_ADMIN';
  } else {
    await apply(ctx, r, actor, override, note);
    r.status = 'APPROVED';
  }
  r.history.push({ by: actor._id, byRole: actor.role, action: decision === 'reject' ? 'REJECTED' : 'APPROVED', note, override });
  await r.save();
  if (r.status.startsWith('PENDING')) notifyPending(r._id); else notifyDecision(r._id);
  await audit(ctx, {
    action: `${decision === 'reject' ? 'REJECTED' : 'APPROVED'}_REQUEST`, entityType: 'ChangeRequest', entityId: r._id,
    subjectId: r.subject, department: subject?.department, location: subject?.location,
    oldData: { status: before }, newData: { status: r.status }, reason: note, override,
  });
  if (override) {
    await audit(ctx, {
      action: 'ADMIN_OVERRIDE', raw: true, entityType: 'ChangeRequest', entityId: r._id, subjectId: r.subject,
      department: subject?.department, location: subject?.location,
      oldData: { status: before }, newData: { status: r.status, decision }, reason: note, override: true,
    });
  }
  return r;
}
