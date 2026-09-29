// Creates the initial Admin from environment variables. Safe to re-run (never duplicates or overwrites).
//   npm run seed:admin
import mongoose from 'mongoose';
import User from '../src/models/User.js';
import AuditLog from '../src/models/AuditLog.js';
import { hashPassword, passwordProblem } from '../src/lib/auth.js';

const email = process.env.ADMIN_EMAIL?.trim().toLowerCase();
const password = process.env.ADMIN_INITIAL_PASSWORD;
const uri = process.env.MONGODB_URI;

if (!uri || !email || !password) {
  console.error('MONGODB_URI, ADMIN_EMAIL and ADMIN_INITIAL_PASSWORD must be set (see .env.example).');
  process.exit(1);
}
const problem = passwordProblem(password);
if (problem) { console.error(`ADMIN_INITIAL_PASSWORD rejected: ${problem}`); process.exit(1); }

await mongoose.connect(uri, { serverSelectionTimeoutMS: 8000 });
try {
  await User.init();
  const existing = await User.findOne({ email });
  if (existing) {
    console.log(`Admin ${email} already exists. Nothing changed.`);
  } else {
    const admin = await User.create({
      role: 'ADMIN', name: 'Administrator', email, status: 'ACTIVE',
      passwordHash: await hashPassword(password), mustChangePassword: true,
    });
    await AuditLog.create({ action: 'ADMIN_ACCOUNT_SEEDED', actorRole: 'ADMIN', actorEmail: email, actorId: admin._id,
      entityType: 'User', entityId: String(admin._id), subjectId: admin._id, reason: 'Initial setup script' });
    console.log(`Admin ${email} created. Password change is required at first login.`);
  }
} finally {
  await mongoose.disconnect();
}
