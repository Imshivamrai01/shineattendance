import { M, getSettings } from '@/lib/db';
import { readJson, bad } from '@/lib/http';
import { salesHandler, mergeLeads, salesRole } from '@/lib/sales';
import { findLeads, enrich } from '@/lib/leadFinder';

export const GET = salesHandler(async (ctx) => ({
  jobs: await M.ScrapeJob.find(ctx.sales === 'MANAGER' ? {} : { by: ctx.user._id }).sort({ createdAt: -1 }).limit(50).populate('by', 'name').lean(),
}));

const brief = (l) => ({ _id: l._id, name: l.name, phone: l.phone, address: l.address, instagram: l.instagram, website: l.website, rating: l.rating, reviews: l.reviews,
  status: l.status, grade: l.grade, score: l.score, timesFound: l.timesFound, callCount: l.callCount, assignedTo: l.assignedTo, category: l.category, firstFoundAt: l.firstFoundAt });

/*
 * Run the lead finder: { location, category, source: AUTO | GOOGLE | OSM, max, onlyWithPhone, assignTo }.
 * New businesses are saved as leads; ones already in the CRM are returned separately as repeats (and counted as found again).
 * Agents' new leads are always assigned to themselves.
 */
export const POST = salesHandler(async (ctx) => {
  const b = await readJson(ctx.req);
  const location = String(b.location || '').trim().slice(0, 120), category = String(b.category || '').trim().slice(0, 80);
  if (location.length < 2) throw bad('Enter the location (area, city)');
  if (category.length < 2) throw bad('Enter the category (restaurant, gym, salon, ...)');
  const max = Math.min(60, Math.max(5, Number(b.max) || 40));
  const s = await getSettings();
  const source = b.source === 'OSM' || (b.source !== 'GOOGLE' && !s.placesKey) ? 'OSM' : 'GOOGLE';
  if (source === 'GOOGLE' && !s.placesKey) throw bad('Add a Google Places API key in Sales settings first, or use OpenStreetMap');
  let assignTo = ctx.sales === 'MANAGER' ? b.assignTo || null : ctx.user._id;
  if (assignTo && ctx.sales === 'MANAGER') {
    const u = await M.User.findById(assignTo).lean();
    if (!u || u.status !== 'ACTIVE' || !salesRole(u)) throw bad('That person has no sales access');
  }

  const started = Date.now();
  const job = await M.ScrapeJob.create({ location, category, source, by: ctx.user._id });
  let found;
  try {
    found = await findLeads({ source, key: s.placesKey, category, location, max });
  } catch (e) {
    job.error = e.message; job.ms = Date.now() - started; await job.save();
    throw bad(source === 'GOOGLE' && e.status === 403 ? `Google rejected the API key: ${e.message}` : e.message);
  }
  const usable = b.onlyWithPhone === false ? found : found.filter((l) => l.phone);
  await enrich(usable, 20);
  const { fresh, repeat } = await mergeLeads(ctx, usable, { category, searchLocation: location, job: job._id, assignTo, source });

  Object.assign(job, { found: found.length, created: fresh.length, repeated: repeat.length, skipped: found.length - usable.length, ms: Date.now() - started });
  await job.save();
  const names = Object.fromEntries((await M.User.find({ _id: { $in: repeat.map((l) => l.assignedTo).filter(Boolean) } }).select('name').lean()).map((u) => [String(u._id), u.name]));
  return {
    job: job.toObject(),
    fresh: fresh.map(brief),
    repeat: repeat.map((l) => ({ ...brief(l), assignedName: names[String(l.assignedTo)] || '' })),
  };
});
