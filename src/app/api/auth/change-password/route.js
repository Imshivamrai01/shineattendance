import { M } from '@/lib/db';
import { handler, readJson, bad } from '@/lib/http';
import { audit } from '@/lib/audit';
import { verifyPassword, hashPassword, passwordProblem, destroyAllSessions, COOKIE } from '@/lib/auth';

export const POST = handler(async (ctx) => {
  const { currentPassword, newPassword } = await readJson(ctx.req);
  const u = await M.User.findById(ctx.user._id).select('+passwordHash');
  if (!(await verifyPassword(String(currentPassword || ''), u.passwordHash))) throw bad('Current password is incorrect');
  const p = passwordProblem(newPassword);
  if (p) throw bad(p);
  if (await verifyPassword(newPassword, u.passwordHash)) throw bad('New password must be different from the current one');
  u.passwordHash = await hashPassword(newPassword);
  u.mustChangePassword = false;
  u.passwordChangedAt = new Date();
  await u.save();
  // Sign out every other device.
  await destroyAllSessions(u._id, ctx.req.cookies.get(COOKIE)?.value);
  await audit(ctx, { action: 'CHANGED_PASSWORD', entityType: 'User', entityId: u._id, subjectId: u._id });
  return { ok: true };
}, { allowPasswordChange: true });
