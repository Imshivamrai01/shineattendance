import { M } from '@/lib/db';
import { handler, readJson, oid, forbidden, notFound, requireReason } from '@/lib/http';
import { audit } from '@/lib/audit';
import { notifyWelcome } from '@/lib/notify';
import { hashPassword, randomPassword, destroyAllSessions } from '@/lib/auth';

export const POST = handler(async (ctx) => {
  const id = oid(ctx.params.id);
  const { reason } = await readJson(ctx.req).catch(() => ({}));
  requireReason(reason);
  const u = await M.User.findById(id);
  if (!u) throw notFound('User not found');
  if (u.role === 'ADMIN') throw forbidden('Use the change-password page for admin accounts');
  const temp = randomPassword();
  u.passwordHash = await hashPassword(temp);
  u.mustChangePassword = true; u.failedLogins = 0; u.lockedUntil = undefined;
  await u.save();
  await destroyAllSessions(u._id);
  notifyWelcome({ userId: u._id, password: temp, kind: 'reset' });
  await audit(ctx, { action: 'RESET_PASSWORD', entityType: 'User', entityId: u._id, subjectId: u._id, reason });
  return { tempPassword: temp };
}, { roles: ['ADMIN'] });
