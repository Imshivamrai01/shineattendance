import { readJson } from '@/lib/http';
import { staffHandler, loadStaffCall, syncContact } from '@/lib/staffCalls';

// One call to an employee: live office-line status while it runs, then what was said.
export const GET = staffHandler(async (ctx) => ({ call: (await loadStaffCall(ctx)).toObject() }));

// { reason, note } — what the employee said, typed by the caller after an office-line call.
export const PATCH = staffHandler(async (ctx) => {
  const sc = await loadStaffCall(ctx, { own: true });
  const b = await readJson(ctx.req);
  if (b.reason != null) sc.reason = String(b.reason).trim().slice(0, 1000);
  if (b.note != null) sc.note = String(b.note).trim().slice(0, 2000);
  await sc.save();
  if (sc.list && sc.contact) await syncContact(sc);
  return { call: sc.toObject() };
});
