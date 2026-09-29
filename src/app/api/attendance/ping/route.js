import { handler, readJson } from '@/lib/http';
import { ping } from '@/lib/attendance';

export const POST = handler(async (ctx) => {
  const body = await readJson(ctx.req).catch(() => ({}));
  return ping(ctx, body);
});
