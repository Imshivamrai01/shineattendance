import crypto from 'node:crypto';
import { HttpError } from './errors.js';

/** Scheduled routes are protected by CRON_SECRET, sent as a Bearer token (Cloudflare cron triggers via worker.js, or Vercel crons). */
export function requireCron(req) {
  const secret = process.env.CRON_SECRET;
  if (!secret) throw new HttpError(503, 'CRON_SECRET is not set');
  const given = (req.headers.get('authorization') || '').replace(/^Bearer /, '');
  const a = Buffer.from(given), b = Buffer.from(secret);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) throw new HttpError(401, 'Unauthorized');
}
