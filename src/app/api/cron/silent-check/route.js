import { handler } from '@/lib/http';
import { requireCron } from '@/lib/cron';
import { silentCheckout } from '@/lib/attendance';

// Every 5 minutes: check out anyone whose phone has stopped reporting its location (see silentCheckout).
export const GET = handler(async (ctx) => {
  requireCron(ctx.req);
  return silentCheckout(ctx);
}, { roles: false });
