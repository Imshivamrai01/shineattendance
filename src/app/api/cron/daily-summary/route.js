import crypto from 'node:crypto';
import { handler, HttpError } from '@/lib/http';
import { sendDailySummary } from '@/lib/notify';
import { mailConfigured } from '@/lib/mailer';

// Called once a day by the host's scheduler (see vercel.json). Protected by CRON_SECRET; Vercel sends it as a Bearer token.
export const GET = handler(async ({ req }) => {
  const secret = process.env.CRON_SECRET;
  if (!secret) throw new HttpError(503, 'CRON_SECRET is not set');
  const given = (req.headers.get('authorization') || '').replace(/^Bearer /, '');
  const a = Buffer.from(given), b = Buffer.from(secret);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) throw new HttpError(401, 'Unauthorized');
  if (!mailConfigured()) return { skipped: 'email is not configured' };
  return sendDailySummary();
}, { roles: false });
