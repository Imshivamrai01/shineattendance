import { handler, readJson, oid } from '@/lib/http';
import { reviewPresence } from '@/lib/attendance';

// Settle a "review required" presence check: { checkId, decision: 'STAYED' | 'LEFT', at?, note }
export const POST = handler(async (ctx) => {
  const b = await readJson(ctx.req);
  const rec = await reviewPresence(ctx, { attendanceId: oid(ctx.params.id), checkId: oid(b.checkId, 'checkId'), decision: b.decision, at: b.at, note: b.note });
  return { ok: true, id: rec._id };
}, { roles: ['ADMIN', 'COO', 'MANAGER', 'HR'] });
