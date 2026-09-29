import { NextResponse } from 'next/server';
import { M } from '@/lib/db';
import { handler, readJson, HttpError } from '@/lib/http';
import { audit } from '@/lib/audit';
import { notifyLockout } from '@/lib/notify';
import { verifyPassword, createSession, cookieOptions, COOKIE } from '@/lib/auth';

const MAX_FAILS = 5, LOCK_MS = 15 * 60 * 1000;
// Compared against when the account doesn't exist, so timing doesn't reveal valid accounts.
const DUMMY = '$2a$12$C6UzMDM.H6dfI/f/IKcEeO5w9zA7Yv9m3Q0uVZ0S8qkq5Zr0q8m0e';

export const POST = handler(async (ctx) => {
  const { identifier, password } = await readJson(ctx.req);
  if (typeof identifier !== 'string' || typeof password !== 'string') throw new HttpError(400, 'Email/mobile and password are required');
  const id = identifier.trim().toLowerCase();
  const user = await M.User.findOne({ $or: [{ email: id }, { mobile: id.replace(/[\s-]/g, '') }, { employeeId: identifier.trim().toUpperCase() }] }).select('+passwordHash');
  const fail = async (why) => {
    await audit(ctx, {
      raw: true, action: user?.role === 'ADMIN' ? 'ADMIN_LOGIN_FAILED' : 'LOGIN_FAILED', entityType: 'Session',
      subjectId: user?._id, actor: user ? user : { email: id }, reason: why,
    });
    throw new HttpError(401, 'Invalid credentials');
  };

  if (!user) { await verifyPassword(password, DUMMY); return fail('Unknown account'); }
  if (user.lockedUntil && user.lockedUntil > new Date()) return fail('Account temporarily locked');
  const ok = await verifyPassword(password, user.passwordHash);
  if (!ok) {
    user.failedLogins = (user.failedLogins || 0) + 1;
    if (user.failedLogins >= MAX_FAILS) { user.lockedUntil = new Date(Date.now() + LOCK_MS); user.failedLogins = 0; notifyLockout({ userId: user._id, ip: ctx.ip }); }
    await user.save();
    return fail('Wrong password');
  }
  if (user.status !== 'ACTIVE') return fail(`Account is ${user.status}`);

  user.failedLogins = 0; user.lockedUntil = undefined; user.lastLoginAt = new Date();
  await user.save();
  const token = await createSession(user._id, ctx);
  if (user.role !== 'EMPLOYEE') await audit({ ...ctx, user }, { action: 'LOGIN', entityType: 'Session', subjectId: user._id });
  const res = NextResponse.json({ ok: true, mustChangePassword: user.mustChangePassword, role: user.role });
  res.cookies.set(COOKIE, token, cookieOptions());
  return res;
}, { roles: false });
