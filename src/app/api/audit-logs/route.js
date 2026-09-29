import { M } from '@/lib/db';
import { handler } from '@/lib/http';

const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export const GET = handler(async ({ req }) => {
  const sp = new URL(req.url).searchParams;
  const q = {};
  const and = [];
  if (sp.get('actorRole')) q.actorRole = sp.get('actorRole');
  if (sp.get('actor')) { const r = new RegExp(esc(sp.get('actor')).slice(0, 80), 'i'); and.push({ actorEmail: r }); }
  if (sp.get('action')) q.action = new RegExp(esc(sp.get('action')).slice(0, 80), 'i');
  if (sp.get('entityType')) q.entityType = sp.get('entityType');
  if (sp.get('department')) q.department = sp.get('department');
  if (sp.get('location')) q.location = sp.get('location');
  if (sp.get('override') === '1') q.override = true;
  if (sp.get('from') || sp.get('to')) {
    q.at = {};
    if (sp.get('from')) q.at.$gte = new Date(sp.get('from'));
    if (sp.get('to')) q.at.$lte = new Date(new Date(sp.get('to')).getTime() + 86400000 - 1);
  }
  // Free text also matches the employee (subject) name/ID.
  const text = sp.get('q')?.trim();
  if (text) {
    const r = new RegExp(esc(text).slice(0, 80), 'i');
    const ids = await M.User.find({ $or: [{ name: r }, { employeeId: r }, { email: r }] }).limit(200).distinct('_id');
    and.push({ $or: [{ subjectId: { $in: ids } }, { actorEmail: r }, { action: r }, { reason: r }] });
  }
  if (sp.get('subject')) q.subjectId = sp.get('subject');
  if (and.length) q.$and = and;
  const limit = Math.min(Number(sp.get('limit')) || 50, 200), page = Math.max(Number(sp.get('page')) || 1, 1);
  const [items, total] = await Promise.all([
    M.AuditLog.find(q).sort({ at: -1 }).skip((page - 1) * limit).limit(limit).lean(),
    M.AuditLog.countDocuments(q),
  ]);
  const subjects = await M.User.find({ _id: { $in: items.map((i) => i.subjectId).filter(Boolean) } }).select('name employeeId').lean();
  const sm = Object.fromEntries(subjects.map((s) => [String(s._id), s]));
  return { items: items.map((i) => ({ ...i, subject: i.subjectId ? sm[String(i.subjectId)] : undefined })), total, page, limit };
}, { roles: ['ADMIN'] });
