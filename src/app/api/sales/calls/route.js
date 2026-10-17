import { M } from '@/lib/db';
import { bad } from '@/lib/http';
import { salesHandler } from '@/lib/sales';

const DAY = /^\d{4}-\d{2}-\d{2}$/;

// Call log for one day (IST): every call with who made it, the lead, the outcome and what was said. Agents see their own.
export const GET = salesHandler(async (ctx) => {
  const q = new URL(ctx.req.url).searchParams;
  const day = q.get('day') || new Date(Date.now() + 330 * 60000).toISOString().slice(0, 10);
  if (!DAY.test(day)) throw bad('Invalid day');
  const from = new Date(`${day}T00:00:00+05:30`), to = new Date(from.getTime() + 86400000);
  const f = { type: 'CALL', createdAt: { $gte: from, $lt: to } };
  if (ctx.sales !== 'MANAGER') f.by = ctx.user._id;
  else if (/^[a-f\d]{24}$/i.test(q.get('by') || '')) f.by = q.get('by');
  const calls = await M.LeadActivity.find(f).sort({ createdAt: -1 }).limit(1000)
    .populate('by', 'name').populate('lead', 'name phone status category').lean();
  // Per person: calls, talked, not yet updated, total talk time
  const people = {};
  for (const c of calls) {
    const k = String(c.by?._id || '');
    const p = (people[k] ||= { _id: k, name: c.by?.name || 'Unknown', calls: 0, talked: 0, pending: 0, seconds: 0 });
    p.calls++;
    if (c.outcome === 'CONNECTED' || c.outcome === 'CALL_BACK') p.talked++;
    if (c.outcome === 'PENDING') p.pending++;
    p.seconds += c.durationSec || 0;
  }
  return { day, calls, people: Object.values(people).sort((a, b) => b.calls - a.calls) };
});
