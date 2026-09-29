import { M } from '@/lib/db';
import { handler, readJson, bad } from '@/lib/http';
import { createUser, scopeFilter, populateUsers, publicUser } from '@/lib/users';

const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export const GET = handler(async ({ req, user }) => {
  const sp = new URL(req.url).searchParams;
  const and = [scopeFilter(user)];
  const role = sp.get('role'), status = sp.get('status'), dept = sp.get('department'), q = sp.get('q')?.trim();
  if (role) and.push({ role });
  and.push(status ? { status } : { status: { $ne: 'ARCHIVED' } });
  if (dept) and.push({ department: dept });
  if (sp.get('unassigned') === 'manager') and.push({ role: 'EMPLOYEE', manager: null });
  if (q) { const r = new RegExp(esc(q).slice(0, 60), 'i'); and.push({ $or: [{ name: r }, { email: r }, { mobile: r }, { employeeId: r }] }); }
  and.push({ role: { $ne: 'ADMIN' } }); // admin accounts are not listed as people
  const filter = { $and: and };
  const limit = Math.min(Number(sp.get('limit')) || 100, 500), page = Math.max(Number(sp.get('page')) || 1, 1);
  const [items, total] = await Promise.all([
    populateUsers(M.User.find(filter).sort({ name: 1 }).skip((page - 1) * limit).limit(limit)),
    M.User.countDocuments(filter),
  ]);
  return { items: items.map(publicUser), total, page, limit };
}, { roles: ['ADMIN', 'COO', 'MANAGER', 'HR'] });

export const POST = handler(async (ctx) => {
  const body = await readJson(ctx.req);
  const { user, tempPassword } = await createUser(ctx, body);
  // The temporary password is returned once and never stored in plain text.
  return { user: publicUser(user), tempPassword };
}, { roles: ['ADMIN', 'HR'] });
