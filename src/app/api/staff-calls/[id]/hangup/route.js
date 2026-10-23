import { staffHandler, loadStaffCall } from '@/lib/staffCalls';
import { hangupOfficeCall } from '@/lib/officeCalls';

// End an office-line call to an employee from the app.
export const POST = staffHandler(async (ctx) => hangupOfficeCall(await loadStaffCall(ctx, { own: true })));
