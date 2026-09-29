import mongoose from 'mongoose';
const { Schema } = mongoose;

const contact = new Schema({ name: String, relationship: String, mobile: String }, { _id: false });

const UserSchema = new Schema({
  employeeId: { type: String, unique: true, sparse: true, trim: true },
  role: { type: String, enum: ['ADMIN', 'COO', 'MANAGER', 'HR', 'EMPLOYEE'], required: true, index: true },
  status: { type: String, enum: ['ACTIVE', 'INACTIVE', 'ARCHIVED'], default: 'ACTIVE', index: true },
  name: { type: String, required: true, trim: true },
  email: { type: String, lowercase: true, trim: true, unique: true, sparse: true },
  mobile: { type: String, trim: true, unique: true, sparse: true },
  passwordHash: { type: String, required: true, select: false },
  mustChangePassword: { type: Boolean, default: true },
  passwordChangedAt: Date,
  failedLogins: { type: Number, default: 0 },
  lockedUntil: Date,
  lastLoginAt: Date,
  // profile: every field optional
  fatherName: String, motherName: String, dob: String,
  address: String, city: String, state: String, pincode: String,
  emergencyContact1: contact, emergencyContact2: contact,
  // employment
  designation: String, joiningDate: String,
  employeeType: { type: String, enum: ['FULL_TIME', 'PART_TIME', 'CONTRACT', 'INTERN'] },
  department: { type: Schema.Types.ObjectId, ref: 'Department', index: true },
  manager: { type: Schema.Types.ObjectId, ref: 'User', index: true },
  hr: { type: Schema.Types.ObjectId, ref: 'User', index: true },
  location: { type: Schema.Types.ObjectId, ref: 'Location' },
  statusReason: String,
  createdBy: { type: Schema.Types.ObjectId, ref: 'User' },
}, { timestamps: true });

export default mongoose.models.User || mongoose.model('User', UserSchema);
