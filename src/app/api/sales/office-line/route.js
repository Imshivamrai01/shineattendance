import { readJson } from '@/lib/http';
import { salesHandler } from '@/lib/sales';
import { officeLine, setCallerPhone } from '@/lib/officeCalls';

// Whether the Call button uses the office line for this person (their phone rings first, then the lead).
export const GET = salesHandler(async (ctx) => officeLine(ctx.user));

// { phone } — the number this person's office-line calls ring first (their own mobile).
export const PUT = salesHandler(async (ctx) => setCallerPhone(ctx.user, (await readJson(ctx.req)).phone));
