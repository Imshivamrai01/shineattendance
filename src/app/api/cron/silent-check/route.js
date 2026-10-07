import { handler } from '@/lib/http';
import { requireCron } from '@/lib/cron';
import { presenceSweep } from '@/lib/attendance';

// Every 5 minutes: ask "Still in office?" when a phone stops reporting, and send unanswered questions to review.
// Nobody is checked out here (see presenceSweep).
export const GET = handler(async (ctx) => {
  requireCron(ctx.req);
  return presenceSweep(ctx);
}, { roles: false });
