import { M } from '@/lib/db';
import { handler, readJson, oid, bad, forbidden } from '@/lib/http';
import { audit } from '@/lib/audit';
import { scopeFilter } from '@/lib/users';
import { notifyCustom } from '@/lib/notify';

const SENDERS = ['ADMIN', 'COO', 'MANAGER', 'HR'];

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

// Send a message to people's bell: Admin / COO / Manager / HR, to everyone they oversee ({ to: 'all' }) or to chosen people ({ to: [ids] }).
export const PUT = handler(async (ctx) => {
  const { user } = ctx;
  if (!SENDERS.includes(user.role)) throw forbidden('Only Admin, COO, Manager or HR can send notifications');
  const b = await readJson(ctx.req);
  const title = String(b.title || '').trim().slice(0, 120), body = String(b.body || '').trim().slice(0, 450);
  if (title.length < 3) throw bad('Enter a title (at least 3 characters)');
  if (body.length < 3) throw bad('Enter the message');
  const mine = await M.User.find({ $and: [scopeFilter(user), { status: 'ACTIVE', _id: { $ne: user._id } }] }).distinct('_id');
  const allowed = new Set(mine.map(String));
  const to = b.to === 'all' ? [...allowed] : (Array.isArray(b.to) ? b.to.map(String).filter((id) => allowed.has(id)) : []);
  if (!to.length) throw bad('Choose at least one person you oversee');
  notifyCustom({ to, title, body, sender: user });
  await audit(ctx, { action: 'SENT_NOTIFICATION', entityType: 'Notification', newData: { title, body, recipients: to.length, all: b.to === 'all' } });
  return { ok: true, sent: to.length };
});
