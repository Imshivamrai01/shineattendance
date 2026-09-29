import { handler, readJson } from '@/lib/http';
import { checkOut } from '@/lib/attendance';

export const POST = handler(async (ctx) => {
  const body = await readJson(ctx.req).catch(() => ({}));
  return { record: await checkOut(ctx, body) };
});
