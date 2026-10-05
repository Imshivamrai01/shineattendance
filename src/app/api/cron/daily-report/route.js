import { handler } from '@/lib/http';
import { requireCron } from '@/lib/cron';
import { endOfDayCheckout } from '@/lib/attendance';
import { finalizeTasks } from '@/lib/tasks';
import { sendDailyReport } from '@/lib/notify';
import { mailConfigured } from '@/lib/mailer';

// 8 PM IST: close anyone still checked in, mark un-updated tasks as late submissions, then email the day's report.
export const GET = handler(async (ctx) => {
  requireCron(ctx.req);
  const checkout = await endOfDayCheckout(ctx);
  const tasks = await finalizeTasks();
  if (!mailConfigured()) return { checkout, tasks, report: 'email is not configured' };
  return { checkout, tasks, report: await sendDailyReport() };
}, { roles: false });
