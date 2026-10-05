import { M } from '@/lib/db';
import { handler } from '@/lib/http';
import { populateUsers, publicUser } from '@/lib/users';
import { photosEnabled } from '@/lib/cloudinary';

export const GET = handler(async ({ user }) => {
  const u = await populateUsers(M.User.findById(user._id));
  return { user: publicUser(u), photosEnabled: photosEnabled() };
}, { allowPasswordChange: true });
