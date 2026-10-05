import { M } from '@/lib/db';
import { handler, readJson, oid, forbidden, bad, requireReason } from '@/lib/http';
import { applyUserChanges, canManage, loadVisibleUser, populateUsers, publicUser } from '@/lib/users';
import { photosEnabled } from '@/lib/cloudinary';

const MANAGER_FIELDS = ['designation', 'department', 'location', 'hr', 'employeeType', 'joiningDate'];
const COO_FIELDS = [...MANAGER_FIELDS, 'manager'];

export const GET = handler(async ({ user, params }) => {
  const id = oid(params.id);
  await loadVisibleUser(user, id);
  const u = await populateUsers(M.User.findById(id));
  const versions = await M.ProfileVersion.find({ user: id }).sort({ field: 1, version: -1 })
    .populate('changedBy', 'name email').lean();
  return { user: publicUser(u), versions, canEdit: canManage(user, u) || String(u._id) === String(user._id), photosEnabled: photosEnabled() };
});

export const PATCH = handler(async (ctx) => {
  const { user, params } = ctx;
  const id = oid(params.id);
  const { changes, reason } = await readJson(ctx.req);
  if (!changes || typeof changes !== 'object') throw bad('changes is required');
  const subject = await loadVisibleUser(user, id);
  if (user.role === 'ADMIN') {
    /* full authority */
  } else if (user.role === 'MANAGER' || user.role === 'COO') {
    if (!canManage(user, subject)) throw forbidden();
    const fields = user.role === 'COO' ? COO_FIELDS : MANAGER_FIELDS;
    const bad_ = Object.keys(changes).filter((k) => !fields.includes(k));
    if (bad_.length) throw forbidden(`You can only change: ${fields.join(', ')}. Others need Admin.`);
  } else throw forbidden('Submit a change request instead');
  const { user: updated, changed } = await applyUserChanges(ctx, { userId: id, changes, reason: requireReason(reason) });
  return { user: publicUser(await populateUsers(M.User.findById(updated._id))), changed };
}, { roles: ['ADMIN', 'COO', 'MANAGER'] });

// "Delete" = archive (soft delete). History is never destroyed.
export const DELETE = handler(async (ctx) => {
  const id = oid(ctx.params.id);
  const { reason } = await readJson(ctx.req).catch(() => ({}));
  const subject = await M.User.findById(id).lean();
  if (!subject) throw bad('User not found');
  if (String(subject._id) === String(ctx.user._id)) throw forbidden('You cannot delete your own account');
  await applyUserChanges(ctx, { userId: id, changes: { status: 'ARCHIVED' }, reason: requireReason(reason) });
  return { ok: true, archived: true };
}, { roles: ['ADMIN'] });
