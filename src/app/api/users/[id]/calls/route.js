import { readJson, bad, oid } from '@/lib/http';
import { loadVisibleUser } from '@/lib/users';
import { staffHandler, staffCallsFor, startStaffAiCall, startStaffOfficeCall } from '@/lib/staffCalls';

// Calls to this employee (AI and office line), newest first.
export const GET = staffHandler(async (ctx) => {
  const u = await loadVisibleUser(ctx.user, oid(ctx.params.id, 'user'));
  return { calls: await staffCallsFor(ctx, u._id) };
});

// { mode: 'AI', purpose } — the voice agent asks why they didn't come in; { mode: 'OFFICE' } — your phone rings first, then theirs.
export const POST = staffHandler(async (ctx) => {
  const b = await readJson(ctx.req).catch(() => ({}));
  if (b.mode === 'AI') return { ok: true, call: (await startStaffAiCall(ctx, { purpose: b.purpose })).toObject() };
  if (b.mode === 'OFFICE') return { ok: true, call: (await startStaffOfficeCall(ctx)).toObject() };
  throw bad('mode must be AI or OFFICE');
});
