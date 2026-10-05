import { handler } from '@/lib/http';
import { issueTrackToken } from '@/lib/auth';

// Called by the Android app (inside its WebView, with the normal login) when tracking starts.
export const POST = handler(async ({ user }) => ({ token: await issueTrackToken(user._id) }), { roles: ['COO', 'MANAGER', 'HR', 'EMPLOYEE'] });
