import { M } from '@/lib/db';
import { toCsv } from '@/lib/csv';
import { salesHandler, leadFilter, CALL_OUTCOMES } from '@/lib/sales';

const ist = (d) => (d ? new Date(d).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' }) : '');

// The leads list (same filters as the page) as a CSV file.
export const GET = salesHandler(async (ctx) => {
  const q = new URL(ctx.req.url).searchParams;
  const leads = await M.Lead.find(leadFilter(ctx, q)).sort({ createdAt: -1 }).limit(10000).populate('assignedTo', 'name').populate('lastCallBy', 'name').lean();
  const rows = [['Name', 'Phone', 'Address', 'Area', 'City', 'Category', 'Instagram', 'Website', 'Email', 'Rating', 'Reviews', 'Status', 'Quality', 'Score',
    'Times found', 'Handled by', 'Calls', 'Connected', 'Last call', 'Last call by', 'Last outcome', 'Next follow-up', 'Source', 'First found', 'Notes', 'Google Maps']];
  for (const l of leads) {
    rows.push([l.name, l.phone, l.address, l.area, l.city, l.category, l.instagram, l.website, l.email, l.rating, l.reviews, l.status, l.grade, l.score,
      l.timesFound, l.assignedTo?.name, l.callCount, l.connectedCount, ist(l.lastCallAt), l.lastCallBy?.name, l.lastOutcome === 'PENDING' ? 'Not updated' : CALL_OUTCOMES[l.lastOutcome] || '',
      ist(l.nextFollowUpAt), l.source, ist(l.firstFoundAt || l.createdAt), l.notes, l.mapsUrl]);
  }
  return new Response('﻿' + toCsv(rows), { headers: {
    'content-type': 'text/csv; charset=utf-8', 'content-disposition': `attachment; filename="leads-${new Date().toISOString().slice(0, 10)}.csv"`,
  } });
});
