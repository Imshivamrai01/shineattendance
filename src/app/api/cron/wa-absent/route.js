import { handler } from '@/lib/http';
import { requireCron } from '@/lib/cron';
import { sendAbsentWhatsApp } from '@/lib/waAuto';

// Every 5 minutes: once office start + the set minutes have passed, WhatsApp everyone who has not checked in (once a day).
export const GET = handler(async (ctx) => {
  requireCron(ctx.req);
  return sendAbsentWhatsApp();
}, { roles: false });
