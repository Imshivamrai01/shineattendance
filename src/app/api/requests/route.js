import { M } from '@/lib/db';
import { handler, readJson } from '@/lib/http';
import { createRequest, canActOn } from '@/lib/workflow';
import { scopeFilter } from '@/lib/users';

export const GET = handler(async ({ req, user }) => {
  const sp = new URL(req.url).searchParams;
  const q = {};
  if (user.role === 'EMPLOYEE') q.requester = user._id;
  else if (user.role !== 'ADMIN') {
    const team = await M.User.find(scopeFilter(user)).distinct('_id');
    q.$or = [{ subject: { $in: team } }, { requester: user._id }];
  }
  if (sp.get('status')) q.status = sp.get('status');
  if (sp.get('pending') === '1') q.status = { $in: ['PENDING_HR', 'PENDING_MANAGER', 'PENDING_COO', 'PENDING_ADMIN'] };
  const items = await M.ChangeRequest.find(q).sort({ createdAt: -1 }).limit(300)
    .populate('requester', 'name role').populate('subject', 'name employeeId hr manager').lean();
  return {
    items: items.map((r) => ({ ...r, canAct: canActOn(user, { ...r, requester: r.requester._id }, r.subject) })),
  };
});

export const POST = handler(async (ctx) => {
  const b = await readJson(ctx.req);
  const r = await createRequest(ctx, { type: b.type, subjectId: b.subjectId, changes: b.changes, payload: b.payload, reason: b.reason });
  return { item: r };
}, { roles: ['EMPLOYEE', 'HR', 'MANAGER', 'COO'] });
