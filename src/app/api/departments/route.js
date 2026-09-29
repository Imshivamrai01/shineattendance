import { M } from '@/lib/db';
import { handler, readJson, bad } from '@/lib/http';
import { audit } from '@/lib/audit';

export const GET = handler(async () => {
  const items = await M.Department.find().sort({ name: 1 }).lean();
  const counts = await M.User.aggregate([{ $match: { status: 'ACTIVE', department: { $ne: null } } }, { $group: { _id: '$department', n: { $sum: 1 } } }]);
  const map = Object.fromEntries(counts.map((c) => [String(c._id), c.n]));
  const names = Object.fromEntries(items.map((d) => [String(d._id), d.name]));
  return { items: items.map((d) => ({ ...d, employees: map[String(d._id)] || 0, parentName: d.parent ? names[String(d.parent)] : undefined })) };
});

export const POST = handler(async (ctx) => {
  const { name, description, parent } = await readJson(ctx.req);
  if (!name?.trim()) throw bad('Department name is required');
  if (parent && !(await M.Department.exists({ _id: parent }))) throw bad('Parent department not found');
  const d = await M.Department.create({ name: name.trim(), description: description?.trim() || undefined, parent: parent || undefined });
  await audit(ctx, { action: 'CREATED_DEPARTMENT', entityType: 'Department', entityId: d._id, newData: { name: d.name, description: d.description, parent: d.parent } });
  return { item: d };
}, { roles: ['ADMIN'] });
