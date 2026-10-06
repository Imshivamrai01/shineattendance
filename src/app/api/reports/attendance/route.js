import { handler } from '@/lib/http';
import { audit } from '@/lib/audit';
import { toCsv } from '@/lib/csv';
import { attendanceRows } from '@/lib/report';
import { queryAttendance } from '@/lib/attendanceQuery';
import { getSettings } from '@/lib/db';

export const GET = handler(async (ctx) => {
  const sp = new URL(ctx.req.url).searchParams;
  const recs = await queryAttendance(ctx.user, sp);
  const csv = toCsv(attendanceRows(recs, await getSettings()));
  await audit(ctx, { action: 'EXPORTED_REPORT', entityType: 'Report', entityId: 'attendance',
    newData: { from: sp.get('from'), to: sp.get('to'), rows: recs.length } });
  return new Response(csv, { headers: { 'content-type': 'text/csv; charset=utf-8', 'content-disposition': 'attachment; filename="attendance.csv"' } });
}, { roles: ['ADMIN', 'COO', 'MANAGER', 'HR'] });
