import { M } from '@/lib/db';
import { handler } from '@/lib/http';
import { populateUsers, publicUser } from '@/lib/users';

export const GET = handler(async ({ user }) => {
  const u = await populateUsers(M.User.findById(user._id));
  return { user: publicUser(u) };
}, { allowPasswordChange: true });
