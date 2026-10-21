import { M } from '@/lib/db';
import { bad } from '@/lib/http';
import { salesHandler, startOfTodayIst } from '@/lib/sales';
import { aiConfigured, aiCallScope, queueStatus } from '@/lib/aiCalls';

const DAY = /^\d{4}-\d{2}-\d{2}$/;

// AI Portal: callbacks waiting for the team, today's numbers, and the call list (newest first).
export const GET = salesHandler(async (ctx) => {
  const q = new URL(ctx.req.url).searchParams;
  const scope = await aiCallScope(ctx);
  // Waiting / removed list entries are shown in the call list panel, not as calls.
  const f = { ...scope, status: { $nin: ['SCHEDULED', 'CANCELLED'] } };
  const day = q.get('day') || '';
  if (day) {
    if (!DAY.test(day)) throw bad('Invalid day');
    const from = new Date(`${day}T00:00:00+05:30`);
    f.createdAt = { $gte: from, $lt: new Date(from.getTime() + 86400000) };
  }
  if (q.get('view') === 'callbacks') Object.assign(f, { callbackRequested: true, handledAt: null });
  if (q.get('view') === 'interested') f.$and = [...(f.$and || []), { $or: [{ outcome: { $in: ['INTERESTED', 'CALLBACK'] } }, { interest: { $in: ['HOT', 'WARM'] } }] }, { optOut: { $ne: true } }];
  if (['outbound', 'inbound'].includes(q.get('direction'))) f.direction = q.get('direction');
  const term = (q.get('q') || '').trim();
  if (term) {
    const rx = new RegExp(term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
    const digits = term.replace(/\D/g, '');
    const or = [{ callerName: rx }, { company: rx }, { requirement: rx }, { summary: rx }, ...(digits.length >= 4 ? [{ phoneKey: new RegExp(digits) }] : [])];
    if (f.$or) { f.$and = [...(f.$and || []), { $or: f.$or }, { $or: or }]; delete f.$or; } else f.$or = or;
  }
  const calls = await M.AiCall.find(f).select('-transcript').sort(q.get('view') === 'callbacks' ? { callbackAt: 1 } : { createdAt: -1 }).limit(300)
    .populate('lead', 'name status assignedTo').populate('requestedBy', 'name').populate('handledBy', 'name').lean();

  const today = { ...scope, status: { $nin: ['SCHEDULED', 'CANCELLED'] }, createdAt: { $gte: startOfTodayIst() } };
  const [total, completed, talked, callbacks, optOuts, openCallbacks, interested, queue] = await Promise.all([
    M.AiCall.countDocuments(today),
    M.AiCall.countDocuments({ ...today, status: 'COMPLETED' }),
    M.AiCall.countDocuments({ ...today, outcome: { $in: ['CALLBACK', 'INTERESTED', 'INFO_GIVEN', 'NOT_INTERESTED', 'OPT_OUT'] } }),
    M.AiCall.countDocuments({ ...today, callbackRequested: true }),
    M.AiCall.countDocuments({ ...today, optOut: true }),
    M.AiCall.countDocuments({ ...scope, callbackRequested: true, handledAt: null }),
    M.AiCall.countDocuments({ ...today, $and: [{ $or: [{ outcome: { $in: ['INTERESTED', 'CALLBACK'] } }, { interest: { $in: ['HOT', 'WARM'] } }] }, { optOut: { $ne: true } }] }),
    queueStatus(ctx),
  ]);
  return { calls, today: { total, completed, talked, callbacks, optOuts, interested }, openCallbacks, queue, connected: aiConfigured() };
});
