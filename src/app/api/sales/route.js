import { M, getSettings } from '@/lib/db';
import { salesHandler, leadScope, salesTeam, startOfTodayIst, endOfTodayIst, CLOSED } from '@/lib/sales';
import { aiCallScope } from '@/lib/aiCalls';

// Sales overview: lead counts, calls made today, follow-ups due, per-person numbers (managers) and recent activity.
export const GET = salesHandler(async (ctx) => {
  const scope = leadScope(ctx);
  const mgr = ctx.sales === 'MANAGER';
  const today = startOfTodayIst(), endToday = endOfTodayIst();
  const open = { status: { $nin: CLOSED } };
  const [[agg], dueToday, overdue, callsToday, categories, s] = await Promise.all([
    M.Lead.aggregate([{ $match: scope }, { $facet: {
      status: [{ $group: { _id: '$status', n: { $sum: 1 } } }],
      grade: [{ $group: { _id: '$grade', n: { $sum: 1 } } }],
      totals: [{ $group: { _id: null, total: { $sum: 1 }, repeat: { $sum: { $cond: [{ $gt: ['$timesFound', 1] }, 1, 0] } },
        called: { $sum: { $cond: [{ $gt: ['$callCount', 0] }, 1, 0] } }, calls: { $sum: '$callCount' },
        unassigned: { $sum: { $cond: [{ $ifNull: ['$assignedTo', false] }, 0, 1] } } } }],
    } }]),
    M.Lead.countDocuments({ ...scope, ...open, nextFollowUpAt: { $gte: today, $lte: endToday } }),
    M.Lead.countDocuments({ ...scope, ...open, nextFollowUpAt: { $lt: today } }),
    M.LeadActivity.aggregate([{ $match: { type: 'CALL', createdAt: { $gte: today }, ...(mgr ? {} : { by: ctx.user._id }) } },
      { $group: { _id: '$by', calls: { $sum: 1 }, connected: { $sum: { $cond: [{ $eq: ['$outcome', 'CONNECTED'] }, 1, 0] } }, leads: { $addToSet: '$lead' } } }]),
    M.Lead.distinct('category', scope),
    getSettings(),
  ]);
  const by = (arr) => Object.fromEntries(arr.map((x) => [x._id, x.n]));
  const t = agg.totals[0] || { total: 0, repeat: 0, called: 0, calls: 0, unassigned: 0 };
  const out = {
    role: ctx.sales, googleReady: !!s.placesKey,
    counts: { ...t, fresh: t.total - t.repeat, notCalled: t.total - t.called, status: by(agg.status), grade: by(agg.grade), dueToday, overdue },
    today: { calls: callsToday.reduce((a, x) => a + x.calls, 0), connected: callsToday.reduce((a, x) => a + x.connected, 0), leads: callsToday.reduce((a, x) => a + x.leads.length, 0) },
    categories: categories.filter(Boolean).sort(),
  };

  const actFilter = mgr ? {} : { $or: [{ by: ctx.user._id }, { lead: { $in: await M.Lead.find(scope).distinct('_id') } }] };
  out.recent = await M.LeadActivity.find(actFilter).sort({ createdAt: -1 }).limit(25).populate('by', 'name').populate('lead', 'name phone status').lean();
  out.scrapes = await M.ScrapeJob.find(mgr ? {} : { by: ctx.user._id }).sort({ createdAt: -1 }).limit(8).populate('by', 'name').lean();
  out.team = await salesTeam();
  // AI Portal tab badge: callbacks the AI agent collected that nobody has taken yet
  out.aiCallbacks = await M.AiCall.countDocuments({ ...(await aiCallScope(ctx)), callbackRequested: true, handledAt: null });
  // Calls this person dialled from the app and has not said how they went yet (last 3 days)
  out.myPending = await M.LeadActivity.find({ type: 'CALL', outcome: 'PENDING', by: ctx.user._id, createdAt: { $gt: new Date(Date.now() - 3 * 86400000) } })
    .sort({ createdAt: -1 }).limit(20).populate('lead', 'name phone status').lean();

  if (mgr) {
    // Per person: leads they hold and what they did today.
    const per = await M.Lead.aggregate([{ $group: { _id: '$assignedTo', leads: { $sum: 1 },
      called: { $sum: { $cond: [{ $gt: ['$callCount', 0] }, 1, 0] } },
      interested: { $sum: { $cond: [{ $eq: ['$status', 'INTERESTED'] }, 1, 0] } },
      converted: { $sum: { $cond: [{ $eq: ['$status', 'CONVERTED'] }, 1, 0] } },
      due: { $sum: { $cond: [{ $and: [{ $gt: ['$nextFollowUpAt', null] }, { $lte: ['$nextFollowUpAt', endToday] }, { $not: [{ $in: ['$status', CLOSED] }] }] }, 1, 0] } } } }]);
    const key = (id) => String(id || '');
    out.board = out.team.map((u) => {
      const p = per.find((x) => key(x._id) === key(u._id)) || {};
      const c = callsToday.find((x) => key(x._id) === key(u._id)) || {};
      return { ...u, leads: p.leads || 0, called: p.called || 0, interested: p.interested || 0, converted: p.converted || 0, due: p.due || 0, callsToday: c.calls || 0, connectedToday: c.connected || 0 };
    });
  }
  return out;
});
