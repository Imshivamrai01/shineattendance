import { handler } from '@/lib/http';
import { requireCron } from '@/lib/cron';
import { dialNext } from '@/lib/aiCalls';

// Every 5 minutes: keep the AI call list moving (normally the next call starts as soon as one ends;
// this catches a call that never reported back, and starts the list again when calling hours open).
export const GET = handler(async (ctx) => {
  requireCron(ctx.req);
  return dialNext();
}, { roles: false });
