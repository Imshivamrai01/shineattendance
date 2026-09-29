// Creates the starting departments. Safe to re-run. More can be added later in the app.
//   npm run seed:departments
import mongoose from 'mongoose';
import Department from '../src/models/Department.js';
import AuditLog from '../src/models/AuditLog.js';

const uri = process.env.MONGODB_URI;
if (!uri) { console.error('MONGODB_URI must be set.'); process.exit(1); }

const TOP = ['WEB DEVELOPER', 'VIDEO EDITOR', 'HR', 'INTERN', 'OPERATIONS']; // OPERATIONS: the COO's department
// INTERN has two sub-departments.
const CHILDREN = { INTERN: ['INTERN - WEB DEVELOPER', 'INTERN - VIDEO EDITOR'] };

await mongoose.connect(uri, { serverSelectionTimeoutMS: 8000 });
try {
  await Department.init();
  const made = [];
  const ensure = async (name, parent) => {
    let d = await Department.findOne({ name });
    if (!d) {
      d = await Department.create({ name, parent: parent?._id });
      await AuditLog.create({ action: 'CREATED_DEPARTMENT', actorRole: 'ADMIN', entityType: 'Department', entityId: String(d._id),
        newData: { name, parent: parent?.name }, reason: 'Initial setup script' });
      made.push(name);
    }
    return d;
  };
  for (const name of TOP) {
    const d = await ensure(name);
    for (const child of CHILDREN[name] || []) await ensure(child, d);
  }
  console.log(made.length ? `Created: ${made.join(', ')}` : 'All departments already exist. Nothing changed.');
} finally {
  await mongoose.disconnect();
}
