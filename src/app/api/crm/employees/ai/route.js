import { handler, readJson } from '@/lib/http';
import { queueStaffAiCalls } from '@/lib/staffCalls';

// AI "why didn't you come in today" calls to several employees: { users: [ids], purpose? }. One call at a time.
export const POST = handler(async (ctx) => {
  const b = await readJson(ctx.req);
  return queueStaffAiCalls(ctx, b.users, { purpose: b.purpose });
}, { roles: ['ADMIN', 'COO'] });
