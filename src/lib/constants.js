// Hierarchy: ADMIN > COO (second in command) > MANAGER > HR > EMPLOYEE
export const ROLES = ['ADMIN', 'COO', 'MANAGER', 'HR', 'EMPLOYEE'];
export const CREATABLE_ROLES = ['COO', 'MANAGER', 'HR', 'EMPLOYEE'];
export const USER_STATUSES = ['ACTIVE', 'INACTIVE', 'ARCHIVED'];
export const EMPLOYEE_TYPES = ['FULL_TIME', 'PART_TIME', 'CONTRACT', 'INTERN'];

// Fields tracked in version history and editable through the change workflow.
export const PROFILE_FIELDS = [
  'name', 'email', 'mobile', 'fatherName', 'motherName', 'dob', 'address', 'city', 'state', 'pincode',
  'emergencyContact1', 'emergencyContact2',
];
// Operational fields: Manager/Admin may change directly, HR only via request.
export const EMPLOYMENT_FIELDS = [
  'designation', 'joiningDate', 'employeeType', 'department', 'manager', 'hr', 'location', 'status', 'employeeId',
];
export const TRACKED_FIELDS = [...PROFILE_FIELDS, ...EMPLOYMENT_FIELDS];
// Fields the employee may request to change for themself.
export const EMPLOYEE_REQUESTABLE = ['mobile', 'fatherName', 'motherName', 'dob', 'address', 'city', 'state',
  'pincode', 'emergencyContact1', 'emergencyContact2'];

// Fields counted for profile completion, with human labels.
export const COMPLETION_FIELDS = {
  name: 'Full name', email: 'Email', mobile: 'Mobile number', fatherName: "Father's name",
  motherName: "Mother's name", dob: 'Date of birth', address: 'Address', city: 'City', state: 'State',
  pincode: 'PIN code', emergencyContact1: 'Emergency contact 1', emergencyContact2: 'Emergency contact 2',
  department: 'Department', designation: 'Designation', joiningDate: 'Joining date', manager: 'Manager',
  location: 'Assigned location',
};

export const NOT_PROVIDED = 'Not Provided';
