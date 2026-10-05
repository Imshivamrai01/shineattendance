import mongoose from 'mongoose';
import { M, model as dbModel } from './db.js';
import { photoUrl } from './cloudinary.js';
import { audit } from './audit.js';
import { bad, forbidden, notFound } from './http.js';
import { hashPassword, randomPassword, passwordProblem, destroyAllSessions } from './auth.js';
import { COMPLETION_FIELDS, TRACKED_FIELDS, EMPLOYEE_TYPES, USER_STATUSES, CREATABLE_ROLES } from './constants.js';
import { queueEmployeeSync } from './sheetSync.js';
import { notifyWelcome, notifyProfileChanged } from './notify.js';
import { scopeFilter } from './scope.js';

const REF_FIELDS = { department: 'Department', manager: 'User', hr: 'User', location: 'Location' };
const DATE_FIELDS = ['dob', 'joiningDate'];
const CONTACT_FIELDS = ['emergencyContact1', 'emergencyContact2'];

const roleLabel = (role) => role;

// ---------- input normalisation ----------
function cleanStr(v, max = 300) {
  if (v == null) return null;
  const s = String(v).trim();
  if (s.length > max) throw bad('Value too long');
  return s === '' ? null : s;
}

export function normalizeChanges(input, allowed = TRACKED_FIELDS) {
  const out = {};
  for (const [k, v] of Object.entries(input || {})) {
    if (!allowed.includes(k)) throw bad(`Field not allowed: ${k}`);
    if (k === 'email') {
      const e = cleanStr(v)?.toLowerCase() ?? null;
      if (e && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e)) throw bad('Invalid email address');
      out[k] = e;
    } else if (k === 'mobile') {
      const m = cleanStr(v)?.replace(/[\s-]/g, '') ?? null;
      if (m && !/^\+?\d{10,15}$/.test(m)) throw bad('Mobile number must be 10-15 digits');
      out[k] = m;
    } else if (k === 'pincode') {
      const p = cleanStr(v);
      if (p && !/^\d{4,10}$/.test(p)) throw bad('Invalid PIN code');
      out[k] = p;
    } else if (DATE_FIELDS.includes(k)) {
      const d = cleanStr(v);
      if (d && (!/^\d{4}-\d{2}-\d{2}$/.test(d) || isNaN(Date.parse(d)))) throw bad(`${k} must be YYYY-MM-DD`);
      out[k] = d;
    } else if (CONTACT_FIELDS.includes(k)) {
      if (v == null || (typeof v === 'object' && !v.name && !v.mobile && !v.relationship)) out[k] = null;
      else {
        const c = { name: cleanStr(v.name, 100), relationship: cleanStr(v.relationship, 50), mobile: cleanStr(v.mobile, 20) };
        if (c.mobile && !/^\+?\d{10,15}$/.test(c.mobile.replace(/[\s-]/g, ''))) throw bad('Emergency contact mobile is invalid');
        out[k] = c;
      }
    } else if (k in REF_FIELDS) {
      const r = cleanStr(v);
      if (r && !mongoose.isValidObjectId(r)) throw bad(`Invalid ${k}`);
      out[k] = r;
    } else if (k === 'status') {
      if (!USER_STATUSES.includes(v)) throw bad('Invalid status');
      out[k] = v;
    } else if (k === 'employeeType') {
      const t = cleanStr(v);
      if (t && !EMPLOYEE_TYPES.includes(t)) throw bad('Invalid employee type');
      out[k] = t;
    } else if (k === 'employeeId') {
      const e = cleanStr(v, 40)?.toUpperCase().replace(/\s+/g, '');
      if (!e) throw bad('Employee ID cannot be empty');
      out[k] = e;
    } else out[k] = cleanStr(v, k === 'address' ? 500 : 150);
  }
  if ('name' in out && !out.name) throw bad('Name cannot be empty');
  return out;
}

async function validateRefs(changes, subject) {
  for (const [field, model] of Object.entries(REF_FIELDS)) {
    const id = changes[field];
    if (!id) continue;
    const doc = await dbModel(model).findById(id).lean();
    if (!doc) throw bad(`Selected ${field} does not exist`);
    if (field === 'manager' && (!['MANAGER', 'COO'].includes(doc.role) || doc.status !== 'ACTIVE')) throw bad('Selected user is not an active Manager or COO');
    if (field === 'hr' && (doc.role !== 'HR' || doc.status !== 'ACTIVE')) throw bad('Selected user is not an active HR');
    if ((field === 'manager' || field === 'hr') && subject && String(doc._id) === String(subject._id)) throw bad('A user cannot be assigned to themself');
  }
}

// ---------- display helpers ----------
async function displayValue(field, value) {
  if (value == null || value === '') return null;
  if (field in REF_FIELDS) {
    const d = await dbModel(REF_FIELDS[field]).findById(value).select('name').lean();
    return d ? d.name : String(value);
  }
  return typeof value === 'object' && value.toObject ? value.toObject() : value;
}
const norm = (v) => JSON.stringify(v == null ? null : (v.toObject ? v.toObject() : v), (k, x) => (x && x._bsontype === 'ObjectId' ? String(x) : x));

// ---------- version history ----------
async function recordVersions(user, diffs, actor, reason) {
  for (const d of diffs) {
    const last = await M.ProfileVersion.findOne({ user: user._id, field: d.field }).sort({ version: -1 }).lean();
    let v = last?.version || 0;
    if (!last && d.oldDisplay != null) {
      await M.ProfileVersion.create({ user: user._id, field: d.field, version: ++v, value: d.oldDisplay, reason: 'Baseline value' });
    }
    await M.ProfileVersion.create({
      user: user._id, field: d.field, version: v + 1, value: d.newDisplay,
      changedBy: actor?._id, changedByRole: actor?.role, reason,
    });
  }
}

// ---------- create ----------
export async function createUser(ctx, data) {
  const { role, password, reason } = data;
  const actor = ctx.user;
  const allowed = actor.role === 'ADMIN' ? ['COO', 'MANAGER', 'HR', 'EMPLOYEE'] : actor.role === 'HR' ? ['EMPLOYEE'] : [];
  if (!allowed.includes(role)) throw forbidden(`You cannot create ${role || 'this type of'} users`);

  const creatable = TRACKED_FIELDS.filter((f) => f !== 'status');
  const changes = normalizeChanges(Object.fromEntries(Object.entries(data).filter(([k]) => creatable.includes(k))), creatable);
  if (!changes.name) throw bad('Name is required');
  if (!data.employeeId || !changes.employeeId) throw bad('Employee ID is required');
  if (role === 'EMPLOYEE' && actor.role === 'HR' && !changes.hr) changes.hr = String(actor._id);
  if (actor.role === 'HR' && changes.hr && changes.hr !== String(actor._id)) throw forbidden('HR can only assign themself as HR');
  await validateRefs(changes, null);

  let tempPassword = null;
  let pw = password;
  if (!pw) { pw = tempPassword = randomPassword(); }
  else { const p = passwordProblem(pw); if (p) throw bad(p); }

  const doc = { ...changes, role, status: data.status === 'INACTIVE' ? 'INACTIVE' : 'ACTIVE',
    passwordHash: await hashPassword(pw), mustChangePassword: true, createdBy: actor._id };
  for (const k of Object.keys(doc)) if (doc[k] == null) delete doc[k];
  const user = await M.User.create(doc);

  const diffs = [];
  for (const f of TRACKED_FIELDS) {
    if (f === 'status' || user[f] == null) continue;
    diffs.push({ field: f, oldDisplay: null, newDisplay: await displayValue(f, user[f]) });
  }
  await recordVersions(user, diffs, actor, 'Created');
  queueEmployeeSync(user._id);
  notifyWelcome({ userId: user._id, password: pw, kind: 'created' });
  await audit(ctx, {
    action: `CREATED_${roleLabel(role)}`, entityType: 'User', entityId: user._id, subjectId: user._id,
    department: user.department, location: user.location, reason: reason || 'Account created',
    newData: { name: user.name, email: user.email, mobile: user.mobile, role, employeeId: user.employeeId },
  });
  return { user, tempPassword };
}

// ---------- update (single choke point for every profile/employment change) ----------
export async function applyUserChanges(ctx, { userId, changes, reason, override = false, actor, action, silent = false }) {
  actor = actor || ctx.user;
  const user = await M.User.findById(userId);
  if (!user) throw notFound('User not found');
  if (user.role === 'ADMIN' && String(user._id) !== String(actor._id)) throw forbidden('Admin accounts cannot be modified by others');
  // Role changes (e.g. Employee -> Manager -> COO) are Admin-only and never applied through requests.
  let newRole = null;
  if ('role' in changes) {
    const { role, ...rest } = changes;
    if (actor.role !== 'ADMIN') throw forbidden('Only Admin can change roles');
    if (user.role === 'ADMIN') throw forbidden('The Admin role cannot be changed');
    if (!CREATABLE_ROLES.includes(role)) throw bad('Invalid role');
    if (role !== user.role) newRole = role;
    changes = rest;
  }
  const clean = normalizeChanges(changes);
  await validateRefs(clean, user);

  const diffs = [];
  if (newRole) diffs.push({ field: 'role', nv: newRole, oldDisplay: user.role, newDisplay: newRole });
  for (const [field, nv] of Object.entries(clean)) {
    const ov = user[field];
    if (norm(ov) === norm(nv)) continue;
    diffs.push({
      field, nv,
      oldDisplay: await displayValue(field, ov),
      newDisplay: await displayValue(field, nv),
    });
  }
  if (!diffs.length) return { user, changed: [] };

  for (const d of diffs) user.set(d.field, d.nv ?? undefined);
  if (clean.status && clean.status !== 'ACTIVE') user.statusReason = reason;
  if (clean.status === 'ACTIVE') user.statusReason = undefined;
  await user.save();
  if (clean.status && clean.status !== 'ACTIVE') await destroyAllSessions(user._id);

  await recordVersions(user, diffs, actor, reason);
  const statusChange = diffs.find((d) => d.field === 'status');
  const verb = action || (statusChange && statusChange.nv === 'INACTIVE' ? 'DEACTIVATED'
    : statusChange && statusChange.nv === 'ARCHIVED' ? 'DELETED' : statusChange ? 'REACTIVATED' : newRole ? 'CHANGED_ROLE_OF' : 'UPDATED');
  queueEmployeeSync(user._id);
  // Approved requests send their own decision email, so only direct edits notify here.
  if (!silent) notifyProfileChanged({ userId: user._id, actor, fields: diffs.map((d) => [d.field, d.oldDisplay, d.newDisplay]), reason });
  await audit(ctx, {
    actor, action: `${verb}_${roleLabel(user.role)}`, entityType: 'User', entityId: user._id, subjectId: user._id,
    department: user.department, location: user.location, reason, override,
    oldData: Object.fromEntries(diffs.map((d) => [d.field, d.oldDisplay])),
    newData: Object.fromEntries(diffs.map((d) => [d.field, d.newDisplay])),
  });
  return { user, changed: diffs.map((d) => d.field) };
}

// ---------- scoping ----------
export { scopeFilter };
export function canManage(actor, subject) {
  if (subject.role === 'ADMIN') return false;
  if (actor.role === 'ADMIN') return true;
  const sameDept = subject.role === 'EMPLOYEE' && actor.department && String(subject.department) === String(actor.department);
  if (actor.role === 'COO') return true;
  if (actor.role === 'MANAGER') return ['HR', 'EMPLOYEE'].includes(subject.role);
  if (actor.role === 'HR') return String(subject.hr) === String(actor._id) || !!sameDept;
  return false;
}
export async function loadVisibleUser(actor, id) {
  // $and: spreading the scope would let a scope's own `_id` clause replace the requested id.
  const u = await M.User.findOne({ $and: [{ _id: id }, scopeFilter(actor)] });
  if (!u) throw notFound('User not found');
  return u;
}

// ---------- output ----------
export function completion(u) {
  const missing = [];
  let done = 0;
  // Admins, COOs and Managers report to nobody (the editor hides the field), so it can't count against them.
  const keys = Object.keys(COMPLETION_FIELDS).filter((k) => !(k === 'manager' && ['ADMIN', 'COO', 'MANAGER'].includes(u.role)));
  for (const k of keys) {
    const v = u[k];
    const ok = CONTACT_FIELDS.includes(k) ? !!(v && v.name && v.mobile) : v != null && v !== '';
    if (ok) done++; else missing.push(COMPLETION_FIELDS[k]);
  }
  return { percent: Math.round((done / keys.length) * 100), missing };
}

const POP = [
  { path: 'department', select: 'name' }, { path: 'manager', select: 'name email' },
  { path: 'hr', select: 'name email' }, { path: 'location', select: 'name' },
];
export const populateUsers = (q) => q.populate(POP);

export function publicUser(u) {
  const o = u.toObject ? u.toObject() : { ...u };
  delete o.passwordHash; delete o.failedLogins; delete o.lockedUntil; delete o.__v;
  o.completion = completion(o);
  o.photoUrl = photoUrl(o.photo);
  return o;
}
