import { handler, readJson, oid } from '@/lib/http';
import { reviewRequest } from '@/lib/workflow';

export const POST = handler(async (ctx) => {
  const b = await readJson(ctx.req);
  const r = await reviewRequest(ctx, oid(ctx.params.id), { decision: b.decision, note: b.note });
  return { item: r };
}, { roles: ['ADMIN', 'COO', 'MANAGER', 'HR'] });
