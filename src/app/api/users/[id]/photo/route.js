import { M } from '@/lib/db';
import { handler, readJson, oid, forbidden, bad } from '@/lib/http';
import { audit } from '@/lib/audit';
import { photosEnabled, photoUrl, uploadProfilePhoto } from '@/lib/cloudinary';

// Profile picture: people change their own; Admin can change anyone's. No approval needed.
async function subjectFor(ctx) {
  const id = oid(ctx.params.id);
  if (String(ctx.user._id) !== id && ctx.user.role !== 'ADMIN') throw forbidden('You can only change your own photo');
  const u = await M.User.findById(id);
  if (!u) throw bad('User not found');
  return u;
}

export const POST = handler(async (ctx) => {
  if (!photosEnabled()) throw bad('Photo storage is not set up on the server');
  const u = await subjectFor(ctx);
  const { photo } = await readJson(ctx.req);
  const old = u.photo?.publicId;
  u.photo = await uploadProfilePhoto(photo, { userId: u._id });
  await u.save();
  await audit(ctx, { action: 'CHANGED_PROFILE_PHOTO', entityType: 'User', entityId: u._id, subjectId: u._id, department: u.department, oldData: { photo: old || null }, newData: { photo: u.photo.publicId } });
  return { photoUrl: photoUrl(u.photo) };
});

export const DELETE = handler(async (ctx) => {
  const u = await subjectFor(ctx);
  const old = u.photo?.publicId;
  u.photo = undefined;
  await u.save();
  await audit(ctx, { action: 'REMOVED_PROFILE_PHOTO', entityType: 'User', entityId: u._id, subjectId: u._id, department: u.department, oldData: { photo: old || null } });
  return { ok: true };
});
