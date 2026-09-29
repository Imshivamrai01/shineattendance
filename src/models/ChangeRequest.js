import mongoose from 'mongoose';
const { Schema } = mongoose;
const S = new Schema({
  type: { type: String, enum: ['PROFILE_CHANGE', 'ATTENDANCE_CORRECTION'], required: true },
  requester: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  subject: { type: Schema.Types.ObjectId, ref: 'User', required: true }, // whose data changes
  changes: Schema.Types.Mixed,   // PROFILE_CHANGE: {field: newValue}
  payload: Schema.Types.Mixed,   // ATTENDANCE_CORRECTION: {attendanceId, sessionId, checkIn, checkOut}
  reason: String,
  status: { type: String, enum: ['PENDING_HR', 'PENDING_MANAGER', 'PENDING_COO', 'PENDING_ADMIN', 'APPROVED', 'REJECTED'], index: true },
  history: [{
    by: { type: Schema.Types.ObjectId, ref: 'User' }, byRole: String, action: String,
    note: String, override: Boolean, at: { type: Date, default: Date.now }, _id: false,
  }],
}, { timestamps: true });
export default mongoose.models.ChangeRequest || mongoose.model('ChangeRequest', S);
