import { salesHandler } from '@/lib/sales';
import { loadCall, hangupOfficeCall } from '@/lib/officeCalls';

// End an office-line call from the app.
export const POST = salesHandler(async (ctx) => hangupOfficeCall(await loadCall(ctx)));
