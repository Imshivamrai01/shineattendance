import { handler, readJson, HttpError } from '@/lib/http';
import { userByTrackToken } from '@/lib/auth';
import { ping } from '@/lib/attendance';

// Location reports from the Android app's background service (Bearer track token, no cookie).
// Same rules as the in-page ping: leaving the office radius, or office closing, checks the person out.
// The service stops itself when the answer is `open: false` or 401.
export const POST = handler(async (ctx) => {
  const user = await userByTrackToken((ctx.req.headers.get('authorization') || '').replace(/^Bearer /, ''));
  if (!user) throw new HttpError(401, 'Tracking is not authorised');
  const body = await readJson(ctx.req).catch(() => ({}));
  return ping({ ...ctx, user }, body);
}, { roles: false });
