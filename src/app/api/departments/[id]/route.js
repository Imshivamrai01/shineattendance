import { M } from '@/lib/db';
import { handler, readJson, oid, notFound, bad, requireReason } from '@/lib/http';
import { audit } from '@/lib/audit';

export const PATCH = handler(async (ctx) => {
  const d = await M.Department.findById(oid(ctx.params.id));
  if (!d) throw notFound('Department not found');
  const { name, description, status, reason } = await readJson(ctx.req);
  requireReason(reason);
  const old = { name: d.name, description: d.description, status: d.status };
  if (name !== undefined) { if (!name.trim()) throw bad('Name cannot be empty'); d.name = name.trim(); }
  if (description !== undefined) d.description = description.trim() || undefined;
  if (status !== undefined) { if (!['ACTIVE', 'INACTIVE'].includes(status)) throw bad('Invalid status'); d.status = status; }
  await d.save();
  await audit(ctx, { action: 'UPDATED_DEPARTMENT', entityType: 'Department', entityId: d._id, oldData: old,
    newData: { name: d.name, description: d.description, status: d.status }, reason });
  return { item: d };
}, { roles: ['ADMIN'] });
