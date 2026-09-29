import { M } from '@/lib/db';
import { handler, readJson, oid, forbidden, notFound, requireReason } from '@/lib/http';
import { canManage } from '@/lib/users';
import { correctAttendance, voidAttendance } from '@/lib/attendance';

// Direct correction: Admin (any) or Manager (own team). HR and Employees use a request.
export const PATCH = handler(async (ctx) => {
  const id = oid(ctx.params.id);
  const b = await readJson(ctx.req);
  const rec = await M.Attendance.findById(id).lean();
  if (!rec) throw notFound('Attendance record not found');
  if (['MANAGER', 'COO'].includes(ctx.user.role)) {
    const subject = await M.User.findById(rec.user).lean();
    if (!canManage(ctx.user, subject)) throw forbidden();
  }
  await correctAttendance(ctx, { attendanceId: id, sessionId: b.sessionId, checkIn: b.checkIn, checkOut: b.checkOut, reason: requireReason(b.reason) });
  return { ok: true };
}, { roles: ['ADMIN', 'COO', 'MANAGER'] });

// Void (never physically deletes).
export const DELETE = handler(async (ctx) => {
  const b = await readJson(ctx.req).catch(() => ({}));
  await voidAttendance(ctx, { attendanceId: oid(ctx.params.id), reason: requireReason(b.reason) });
  return { ok: true, voided: true };
}, { roles: ['ADMIN'] });
