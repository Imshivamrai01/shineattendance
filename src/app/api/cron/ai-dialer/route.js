import { handler } from '@/lib/http';
import { requireCron } from '@/lib/cron';
import { dialNext, syncMissingRecordings } from '@/lib/aiCalls';

// Every 5 minutes: keep the AI call list moving (normally the next call starts as soon as one ends;
// this catches a call that never reported back, and starts the list again when calling hours open), and fetch
// recordings that are still missing.
export const GET = handler(async (ctx) => {
  requireCron(ctx.req);
  const dial = await dialNext();
  // Also pick up recordings whose VoBiz callback never came.
  return { ...dial, recordings: await syncMissingRecordings() };
}, { roles: false });
