import { M } from '@/lib/db';
import { readJson, bad } from '@/lib/http';
import { salesHandler, leadFilter, mergeLeads, salesRole } from '@/lib/sales';

const SORTS = { recent: { createdAt: -1 }, score: { score: -1, createdAt: -1 }, followup: { nextFollowUpAt: 1 }, called: { lastCallAt: -1 }, found: { timesFound: -1, lastFoundAt: -1 }, name: { name: 1 } };
const PAGE = 50;

export const GET = salesHandler(async (ctx) => {
  const q = new URL(ctx.req.url).searchParams;
  const f = leadFilter(ctx, q);
  const sort = SORTS[q.get('sort')] || (q.get('due') ? SORTS.followup : SORTS.recent);
  const page = Math.max(1, Number(q.get('page')) || 1);
  const [leads, total] = await Promise.all([
    M.Lead.find(f).sort(sort).skip((page - 1) * PAGE).limit(PAGE).populate('assignedTo', 'name').populate('lastCallBy', 'name')
      .select('-scrapes -nameKey -altPhones -scoreNotes').lean(),
    M.Lead.countDocuments(f),
  ]);
  return { leads, total, page, pages: Math.max(1, Math.ceil(total / PAGE)) };
});

// Add a lead by hand. If the business is already in the CRM it is not added again: it is marked found again (Repeat).
export const POST = salesHandler(async (ctx) => {
  const b = await readJson(ctx.req);
  const name = String(b.name || '').trim();
  if (name.length < 2) throw bad('Business name is required');
  if (!b.phone && !b.instagram) throw bad('Give a phone number or an Instagram profile');
  const assignTo = ctx.sales === 'MANAGER' ? b.assignedTo || null : ctx.user._id;
  if (assignTo && ctx.sales === 'MANAGER') {
    const u = await M.User.findById(assignTo).lean();
    if (!u || u.status !== 'ACTIVE' || !salesRole(u)) throw bad('That person has no sales access');
  }
  const pick = (k, n = 300) => (b[k] == null ? '' : String(b[k]).trim().slice(0, n));
  const { fresh, repeat } = await mergeLeads(ctx, [{
    name, phone: pick('phone', 30), address: pick('address'), area: pick('area', 100), city: pick('city', 100), instagram: pick('instagram'),
    website: pick('website'), email: pick('email', 120), notes: pick('notes', 2000), category: pick('category', 80),
  }], { assignTo, source: 'MANUAL' });
  const lead = fresh[0] || repeat[0];
  return { repeat: !fresh.length, lead: await M.Lead.findById(lead._id).populate('assignedTo', 'name').lean() };
});
