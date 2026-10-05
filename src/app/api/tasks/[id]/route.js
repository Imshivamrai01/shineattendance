import { handler, readJson, oid } from '@/lib/http';
import { ASSIGNER_ROLES, deleteTask, updateTask } from '@/lib/tasks';

export const PATCH = handler(async (ctx) => {
  const body = await readJson(ctx.req);
  return { task: await updateTask(ctx, oid(ctx.params.id), body) };
}, { roles: ASSIGNER_ROLES });

export const DELETE = handler((ctx) => deleteTask(ctx, oid(ctx.params.id)), { roles: ASSIGNER_ROLES });
