// What may `me` change on `subject`, and how (saved at once, or sent up for approval)?
// The server enforces the same rules; this only decides what the edit page shows.
export const ALL_FIELDS = ['name', 'email', 'mobile', 'fatherName', 'motherName', 'dob', 'address', 'city', 'state', 'pincode', 'emergencyContact1', 'emergencyContact2',
  'designation', 'joiningDate', 'employeeType', 'department', 'manager', 'hr', 'location', 'employeeId'];
export const PROFILE_FIELDS = ALL_FIELDS.slice(0, 12);
export const SELF_REQUEST_FIELDS = ['mobile', 'fatherName', 'motherName', 'dob', 'address', 'city', 'state', 'pincode', 'emergencyContact1', 'emergencyContact2'];
const MANAGER_FIELDS = ['designation', 'department', 'location', 'hr', 'employeeType', 'joiningDate'];
const COO_FIELDS = [...MANAGER_FIELDS, 'manager'];

/** Who reviews a change raised by this role (Admin edits are never reviewed). */
export function approvalPath(role, self) {
  if (role === 'EMPLOYEE') return 'your HR, then your Manager or COO';
  if (role === 'HR') return self ? 'your Manager or COO' : "the employee's Manager or COO";
  if (role === 'MANAGER') return 'the COO';
  if (role === 'COO') return 'the Admin';
  return null;
}

export function planEdit(me, subject, wantMode) {
  const self = String(me._id) === String(subject._id);
  if (me.role === 'ADMIN') return { mode: 'direct', fields: self ? ALL_FIELDS : ['role', ...ALL_FIELDS], note: null };
  if (self) return { mode: 'request', fields: SELF_REQUEST_FIELDS, note: approvalPath(me.role, true) };
  if (['COO', 'MANAGER'].includes(me.role) && wantMode !== 'request') return { mode: 'direct', fields: me.role === 'COO' ? COO_FIELDS : MANAGER_FIELDS, note: null };
  if (['HR', 'MANAGER', 'COO'].includes(me.role)) return { mode: 'request', fields: PROFILE_FIELDS, note: approvalPath(me.role, false) };
  return null;
}
