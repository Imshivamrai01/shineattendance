import { readJson } from '@/lib/http';
import { aiConfigured } from '@/lib/aiCalls';
import { staffHandler } from '@/lib/staffCalls';
import { officeLine, setCallerPhone } from '@/lib/officeCalls';

// Whether this person can call employees through the office line, and whether the AI agent is connected.
export const GET = staffHandler(async (ctx) => ({ ...(await officeLine(ctx.user)), ai: aiConfigured() }));

// { phone } — the number office-line calls ring first (their own mobile).
export const PUT = staffHandler(async (ctx) => ({ ...(await setCallerPhone(ctx.user, (await readJson(ctx.req)).phone)), ai: aiConfigured() }));
