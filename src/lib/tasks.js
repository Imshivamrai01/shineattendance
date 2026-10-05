import { M } from './db.js';
import { audit } from './audit.js';
import { bad, forbidden, notFound } from './http.js';
import { dateKey } from './dates.js';
import { canManage, scopeFilter } from './users.js';
import { queueTaskSync, queueTaskRemoved, populateTask } from './sheetSync.js';
import { taskScore, taskLabel } from './taskScore.js';
import { note as inApp } from './notify.js';

// Daily tasks: HR (or Manager / COO / Admin) assigns work for a day and marks it done or not done in the evening.
export const ASSIGNER_ROLES = ['ADMIN', 'COO', 'MANAGER', 'HR'];
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const STATUSES = ['PENDING', 'DONE', 'NOT_DONE'];

/** People this actor can give tasks to (active, not Admin, not themselves). */
export function assignableUsers(actor) {
  return M.User.find({ $and: [scopeFilter(actor), { status: 'ACTIVE', role: { $ne: 'ADMIN' }, _id: { $ne: actor._id } }] })
    .select('name employeeId role designation').sort({ name: 1 }).lean();
}

async function managedSubject(actor, userId) {
  if (!ASSIGNER_ROLES.includes(actor.role)) throw forbidden('Only HR, Manager, COO or Admin can manage tasks');
  const subject = await M.User.findById(userId).lean();
  if (!subject || subject.status !== 'ACTIVE') throw notFound('Person not found');
  if (String(subject._id) === String(actor._id) || !canManage(actor, subject)) throw forbidden('You cannot manage tasks for this person');
  return subject;
}

const text = (v, max) => (typeof v === 'string' ? v.trim().slice(0, max) : '');

export async function createTask(ctx, { userId, date, title, details }) {
  const subject = await managedSubject(ctx.user, userId);
  const day = date || dateKey();
  if (!DATE.test(day)) throw bad('Invalid date');
  if (day < dateKey()) throw bad('Tasks can only be assigned for today or a later day');
  const t = text(title, 200);
  if (t.length < 3) throw bad('Enter the task (at least 3 characters)');
  const task = await M.Task.create({ user: subject._id, date: day, title: t, details: text(details, 2000) || undefined, assignedBy: ctx.user._id });
  await audit(ctx, { action: 'ASSIGNED_TASK', entityType: 'Task', entityId: task._id, subjectId: subject._id, department: subject.department,
    newData: { date: day, title: t } });
  queueTaskSync(task._id);
  inApp(subject._id, { title: 'New task assigned', body: `${t} (for ${day}), from ${ctx.user.name}.`, link: '/tasks' });
  return task.toObject();
}

export async function updateTask(ctx, id, { status, note, title, details }) {
  const task = await M.Task.findById(id);
  if (!task) throw notFound('Task not found');
  const subject = await managedSubject(ctx.user, task.user);
  const old = { status: task.status, late: task.late, note: task.note, title: task.title };
  if (status !== undefined) {
    if (!STATUSES.includes(status)) throw bad('Invalid status');
    const today = dateKey();
    task.status = status;
    // Done on (or before) its day scores; not done, or done on a later day, is a late submission.
    task.late = status === 'NOT_DONE' || (status === 'DONE' && today > task.date) || (status === 'PENDING' && today > task.date);
    task.reviewedBy = ctx.user._id; task.reviewedAt = new Date();
  }
  if (note !== undefined) task.note = text(note, 500) || undefined;
  if (title !== undefined) { const t = text(title, 200); if (t.length < 3) throw bad('Enter the task (at least 3 characters)'); task.title = t; }
  if (details !== undefined) task.details = text(details, 2000) || undefined;
  await task.save();
  await audit(ctx, { action: 'UPDATED_TASK', entityType: 'Task', entityId: task._id, subjectId: subject._id, department: subject.department,
    oldData: old, newData: { status: task.status, late: task.late, note: task.note, title: task.title } });
  queueTaskSync(task._id);
  if (status !== undefined && status !== old.status) {
    inApp(subject._id, { title: `Task marked: ${taskLabel(task)}`, body: `${task.title}${task.note ? `. Note: ${task.note}` : ''}`, link: '/tasks' });
  }
  return task.toObject();
}

export async function deleteTask(ctx, id) {
  const task = await M.Task.findById(id);
  if (!task) throw notFound('Task not found');
  const subject = await managedSubject(ctx.user, task.user);
  const snapshot = await populateTask(M.Task.findById(task._id)).lean();
  await M.Task.deleteOne({ _id: task._id });
  await audit(ctx, { action: 'DELETED_TASK', entityType: 'Task', entityId: task._id, subjectId: subject._id, department: subject.department,
    oldData: { date: task.date, title: task.title, status: task.status } });
  queueTaskRemoved(snapshot);
  return { ok: true };
}

/**
 * Tasks the actor may see. Employees (and anyone asking for `mine`) see their own;
 * assigners see the people in their scope. Filters: date or from/to, user.
 */
export async function listTasks(actor, { date, from, to, userId, mine }) {
  const q = {};
  if (date) { if (!DATE.test(date)) throw bad('Invalid date'); q.date = date; }
  else if (from || to) {
    if ((from && !DATE.test(from)) || (to && !DATE.test(to))) throw bad('Invalid date');
    q.date = { ...(from ? { $gte: from } : {}), ...(to ? { $lte: to } : {}) };
  }
  if (mine || !ASSIGNER_ROLES.includes(actor.role)) q.user = actor._id;
  else {
    const visible = await M.User.find({ $and: [scopeFilter(actor), { role: { $ne: 'ADMIN' } }] }).select('_id').lean();
    const ids = visible.map((u) => String(u._id)).filter((x) => x !== String(actor._id));
    q.user = { $in: userId ? ids.filter((x) => x === String(userId)) : ids };
  }
  const tasks = await M.Task.find(q).sort({ date: -1, createdAt: 1 }).limit(1000)
    .populate('user', 'name employeeId role').populate('assignedBy', 'name role').populate('reviewedBy', 'name role').lean();
  return tasks.map((t) => ({ ...t, score: taskScore(t), label: taskLabel(t) }));
}

/** Evening job: tasks still pending for the day become late submissions (score 0). HR can still mark them done the same day. */
export async function finalizeTasks(date = dateKey()) {
  const pending = await M.Task.find({ date, status: 'PENDING' }).select('_id').lean();
  if (!pending.length) return { finalized: 0 };
  const ids = pending.map((t) => t._id);
  await M.Task.updateMany({ _id: { $in: ids } }, { $set: { status: 'NOT_DONE', late: true } });
  await M.Task.updateMany({ _id: { $in: ids }, note: { $in: [null, ''] } }, { $set: { note: 'Not updated by the end of the day' } });
  for (const t of pending) queueTaskSync(t._id);
  return { finalized: pending.length };
}
