import { handler, readJson, oid } from '@/lib/http';
import { submitTaskUpdate } from '@/lib/tasks';

// The assignee's own update on their task (anyone can have tasks: Employee, HR, Manager, COO).
export const POST = handler(async (ctx) => {
  const body = await readJson(ctx.req);
  return { task: await submitTaskUpdate(ctx, oid(ctx.params.id), body) };
});
