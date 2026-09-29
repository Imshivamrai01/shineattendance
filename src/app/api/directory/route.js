import { M } from '@/lib/db';
import { handler } from '@/lib/http';

// Minimal name list of active COO/Managers/HR for assignment dropdowns.
export const GET = handler(async ({ req }) => {
  const role = new URL(req.url).searchParams.get('role');
  if (!['COO', 'MANAGER', 'HR'].includes(role)) return { items: [] };
  const items = await M.User.find({ role, status: 'ACTIVE' }).select('name employeeId').sort({ name: 1 }).lean();
  return { items };
}, { roles: ['ADMIN', 'HR', 'MANAGER', 'COO'] });
