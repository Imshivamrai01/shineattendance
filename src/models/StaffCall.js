import mongoose from 'mongoose';
const { Schema } = mongoose;

// A call from the CRM to an employee (usually "you didn't come in today, why?") or to someone on a CRM list
// (interview candidate, customer): either the AI agent rings them (aiCall), or the office line rings the caller's
// own phone first and then them (bridge).
const S = new Schema({
  section: { type: String, enum: ['EMPLOYEE', 'INTERVIEW', 'FEEDBACK'], default: 'EMPLOYEE', index: true },
  employee: { type: Schema.Types.ObjectId, ref: 'User', index: true },
  list: { type: Schema.Types.ObjectId, ref: 'ContactList', index: true }, contact: Schema.Types.ObjectId, contactName: String,
  by: { type: Schema.Types.ObjectId, ref: 'User', required: true },
  date: { type: String, index: true }, // YYYY-MM-DD (India) the call is about
  mode: { type: String, enum: ['AI', 'OFFICE'], required: true },
  phone: String,
  purpose: { type: String, maxlength: 300 },
  aiCall: { type: Schema.Types.ObjectId, ref: 'AiCall' },
  // AI calls: IN_PROGRESS until the agent reports the end. Office-line calls use bridge.status.
  status: { type: String, enum: ['IN_PROGRESS', 'COMPLETED', 'NO_ANSWER', 'FAILED'], default: 'IN_PROGRESS' },
  // What the employee said: the AI summary, or what the caller typed after an office-line call
  reason: { type: String, maxlength: 1000 },
  note: { type: String, trim: true, maxlength: 2000 },
  durationSec: Number,
  // Same shape as an office-line CALL on a lead
  bridge: {
    callId: { type: String, index: true, sparse: true },
    status: { type: String, enum: ['CALLING_AGENT', 'AGENT_NO_ANSWER', 'RINGING_LEAD', 'CONNECTED', 'ENDED', 'NO_ANSWER', 'BUSY', 'FAILED'] },
    leadAnsweredAt: Date, talkSec: Number, reason: String,
    recordingId: String, recordingDurationSec: Number,
    transcript: [{ _id: false, role: { type: String, enum: ['team', 'customer'] }, content: String }],
    summary: { type: String, maxlength: 1500 },
  },
}, { timestamps: true });
S.index({ employee: 1, createdAt: -1 });
export default mongoose.models.StaffCall || mongoose.model('StaffCall', S);
