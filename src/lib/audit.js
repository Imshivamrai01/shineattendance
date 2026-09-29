import { M } from './db.js';

/**
 * Append an immutable audit entry. The actor's role is prefixed to the action
 * (ADMIN_CORRECTED_ATTENDANCE, HR_CREATED_EMPLOYEE, ...) unless `raw` is set.
 * `ctx` is the handler context ({ user, ip, device, rid }).
 */
export async function audit(ctx, { action, entityType, entityId, subjectId, department, location,
  oldData, newData, reason, override = false, raw = false, actor }) {
  const a = actor || ctx.user;
  return M.AuditLog.create({
    actorId: a?._id, actorEmail: a?.email || a?.mobile, actorRole: a?.role,
    action: raw || !a?.role ? action : `${a.role}_${action}`,
    entityType, entityId: entityId != null ? String(entityId) : undefined,
    subjectId, department, location, oldData, newData, reason, override,
    ip: ctx.ip, device: ctx.device, requestId: ctx.rid,
  });
}
