import { handler, readJson } from '@/lib/http';
import { dateKey } from '@/lib/dates';
import { ASSIGNER_ROLES, assignableUsers, createTask, listTasks } from '@/lib/tasks';

// GET ?date=YYYY-MM-DD | ?from=&to=  [&user=id] [&mine=1]. Assigners also get the people they can assign to.
export const GET = handler(async ({ req, user }) => {
  const sp = new URL(req.url).searchParams;
  const range = sp.get('from') || sp.get('to');
  const tasks = await listTasks(user, {
    date: range ? undefined : sp.get('date') || dateKey(), from: sp.get('from'), to: sp.get('to'),
    userId: sp.get('user'), mine: sp.get('mine') === '1',
  });
  const canAssign = ASSIGNER_ROLES.includes(user.role);
  return { today: dateKey(), canAssign, tasks, people: canAssign && sp.get('mine') !== '1' ? await assignableUsers(user) : undefined };
});

export const POST = handler(async (ctx) => {
  const body = await readJson(ctx.req);
  return { task: await createTask(ctx, body) };
}, { roles: ASSIGNER_ROLES });
