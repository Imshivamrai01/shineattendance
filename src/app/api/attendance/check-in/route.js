import { handler, readJson } from '@/lib/http';
import { checkIn } from '@/lib/attendance';

export const POST = handler(async (ctx) => {
  const body = await readJson(ctx.req).catch(() => ({}));
  return { record: await checkIn(ctx, body) };
});
