import crypto from 'node:crypto';
import bcrypt from 'bcryptjs';
import { M } from './db.js';

export const COOKIE = 'sid';
const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');
export const sessionMs = () => (Number(process.env.SESSION_HOURS) || 8) * 3600 * 1000;

export function passwordProblem(pw) {
  if (typeof pw !== 'string' || pw.length < 10) return 'Password must be at least 10 characters';
  if (pw.length > 128) return 'Password is too long';
  if (!/[a-z]/.test(pw) || !/[A-Z]/.test(pw) || !/\d/.test(pw)) return 'Password needs upper case, lower case and a number';
  return null;
}
export const hashPassword = (pw) => bcrypt.hash(pw, 12);
export const verifyPassword = (pw, hash) => bcrypt.compare(pw, hash);
export function randomPassword() {
  // Guaranteed to satisfy the policy.
  return 'Tmp' + crypto.randomBytes(6).toString('base64url') + crypto.randomInt(10, 99);
}

export async function createSession(userId, { ip, device }) {
  const token = crypto.randomBytes(32).toString('base64url');
  await M.Session.create({ tokenHash: sha(token), user: userId, expiresAt: new Date(Date.now() + sessionMs()), ip, device });
  return token;
}

export const cookieOptions = () => ({
  httpOnly: true, sameSite: 'lax', secure: process.env.NODE_ENV === 'production', path: '/',
  maxAge: Math.floor(sessionMs() / 1000),
});

export async function getAuthUser(req) {
  const token = req.cookies.get(COOKIE)?.value;
  if (!token) return null;
  const s = await M.Session.findOne({ tokenHash: sha(token), expiresAt: { $gt: new Date() } }).lean();
  if (!s) return null;
  const user = await M.User.findById(s.user).lean();
  if (!user || user.status !== 'ACTIVE') return null;
  return user;
}

export async function destroySession(req) {
  const token = req.cookies.get(COOKIE)?.value;
  if (token) await M.Session.deleteOne({ tokenHash: sha(token) });
}
export const destroyAllSessions = (userId, exceptToken) =>
  M.Session.deleteMany({ user: userId, ...(exceptToken ? { tokenHash: { $ne: sha(exceptToken) } } : {}) });

// ---- Android app: background location ----
// The app's location service runs without the browser session, so it gets its own long-lived token.
// It can only report location (POST /api/attendance/track); a new token replaces the previous one.
export async function issueTrackToken(userId) {
  const token = crypto.randomBytes(32).toString('base64url');
  await M.User.updateOne({ _id: userId }, { $set: { trackTokenHash: sha(token) } });
  return token;
}
export async function userByTrackToken(token) {
  if (typeof token !== 'string' || token.length < 20) return null;
  return M.User.findOne({ trackTokenHash: sha(token), status: 'ACTIVE' }).lean();
}
