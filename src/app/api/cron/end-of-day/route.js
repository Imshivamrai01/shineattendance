import { handler } from '@/lib/http';
import { requireCron } from '@/lib/cron';
import { endOfDayCheckout } from '@/lib/attendance';

// Runs every 15 minutes in the evening; once office hours are over it checks out everyone still checked in.
export const GET = handler(async (ctx) => {
  requireCron(ctx.req);
  return endOfDayCheckout(ctx);
}, { roles: false });
