import { M } from '@/lib/db';
import { handler, readJson, bad } from '@/lib/http';
import { audit } from '@/lib/audit';
import { parseCsv } from '@/lib/csv';
import { createUser } from '@/lib/users';

const HEADERS = {
  employeeid: 'employeeId', name: 'name', fullname: 'name', email: 'email', mobile: 'mobile', phone: 'mobile',
  department: 'department', designation: 'designation', manager: 'manager', hr: 'hr', location: 'location',
  role: 'role', joiningdate: 'joiningDate', employeetype: 'employeeType',
};
const rx = (s) => new RegExp('^' + s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '$', 'i');

async function findPerson(v, role) {
  if (!v) return null;
  const q = { role: Array.isArray(role) ? { $in: role } : role, status: 'ACTIVE', $or: [{ email: v.toLowerCase() }, { employeeId: v }, { mobile: v }] };
  return M.User.findOne(q).select('_id').lean();
}

// Valid rows are imported; invalid rows are reported (never rejects the whole file).
export const POST = handler(async (ctx) => {
  const { csv } = await readJson(ctx.req);
  if (typeof csv !== 'string' || !csv.trim()) throw bad('CSV content is required');
  const rows = parseCsv(csv);
  if (rows.length < 2) throw bad('CSV needs a header row and at least one data row');
  if (rows.length > 2001) throw bad('Import at most 2000 rows at a time');
  const cols = rows[0].map((h) => HEADERS[h.toLowerCase().replace(/[^a-z]/g, '')] || null);
  if (!cols.includes('name')) throw bad('CSV must contain a Name column');

  const created = [], errors = [], warnings = [];
  for (let i = 1; i < rows.length; i++) {
    const rec = {};
    cols.forEach((c, j) => { if (c && rows[i][j]?.trim()) rec[c] = rows[i][j].trim(); });
    const line = i + 1;
    try {
      const data = { ...rec, role: (rec.role || 'EMPLOYEE').toUpperCase(), reason: 'Bulk import' };
      if (rec.department) {
        let d = await M.Department.findOne({ name: rx(rec.department) });
        if (!d) {
          d = await M.Department.create({ name: rec.department });
          await audit(ctx, { action: 'CREATED_DEPARTMENT', entityType: 'Department', entityId: d._id, newData: { name: d.name }, reason: 'Created by import' });
        }
        data.department = String(d._id);
      }
      if (rec.location) {
        const l = await M.Location.findOne({ name: rx(rec.location) }).lean();
        if (l) data.location = String(l._id); else { delete data.location; warnings.push({ row: line, warning: `Location "${rec.location}" not found; left unassigned` }); }
      }
      for (const [k, role] of [['manager', ['MANAGER', 'COO']], ['hr', 'HR']]) {
        if (!rec[k]) continue;
        const p = await findPerson(rec[k], role);
        if (p) data[k] = String(p._id); else { delete data[k]; warnings.push({ row: line, warning: `${k} "${rec[k]}" not found; left unassigned` }); }
      }
      const { user, tempPassword } = await createUser(ctx, data);
      created.push({ row: line, name: user.name, employeeId: user.employeeId, login: user.email || user.mobile, tempPassword });
    } catch (e) {
      errors.push({ row: line, error: e.code === 11000 ? 'Duplicate email, mobile or employee ID' : e.message });
    }
  }
  await audit(ctx, { action: 'IMPORTED_USERS', entityType: 'User', newData: { imported: created.length, failed: errors.length }, reason: 'Bulk import' });
  return { imported: created.length, failed: errors.length, created, errors, warnings };
}, { roles: ['ADMIN'] });
