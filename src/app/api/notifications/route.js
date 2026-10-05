import { M } from '@/lib/db';
import { handler, readJson, oid } from '@/lib/http';

// The bell: unread notifications for the signed-in person, newest first.
export const GET = handler(async ({ user }) => {
  const q = { user: user._id, readAt: null };
  const [items, count] = await Promise.all([
    M.Notification.find(q).sort({ createdAt: -1 }).limit(30).select('title body link createdAt').lean(),
    M.Notification.countDocuments(q),
  ]);
  return { items, count };
});

// Mark one ({ id }) or all ({ all: true }) as read; read notifications drop out of the list.
export const POST = handler(async ({ req, user }) => {
  const b = await readJson(req);
  const q = { user: user._id, readAt: null, ...(b.all ? {} : { _id: oid(b.id) }) };
  const r = await M.Notification.updateMany(q, { $set: { readAt: new Date() } });
  return { ok: true, read: r.modifiedCount };
});
