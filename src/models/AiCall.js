import mongoose from 'mongoose';
const { Schema } = mongoose;

export const AI_INTERESTS = ['HOT', 'WARM', 'COLD', 'NOT_INTERESTED'];
export const AI_OUTCOMES = ['CALLBACK', 'INTERESTED', 'INFO_GIVEN', 'NOT_INTERESTED', 'OPT_OUT', 'NO_CONVERSATION', 'FAILED'];

// One call handled by the AI voice agent (inbound or outbound), as reported by the voice worker.
// The voice worker is the source of truth for the conversation; the CRM keeps this copy plus the lead it touched.
const S = new Schema({
  callId: { type: String, required: true, unique: true }, // VoBiz CallUUID
  direction: { type: String, enum: ['outbound', 'inbound', 'web'], default: 'outbound' },
  status: { type: String, enum: ['QUEUED', 'IN_PROGRESS', 'COMPLETED', 'FAILED'], default: 'QUEUED', index: true },
  phone: String, // the other party, E.164
  phoneKey: { type: String, index: true },
  lead: { type: Schema.Types.ObjectId, ref: 'Lead', index: true },
  requestedBy: { type: Schema.Types.ObjectId, ref: 'User' }, // who pressed "AI call" (outbound from the CRM)
  purpose: { type: String, maxlength: 300 },
  startedAt: Date, endedAt: Date, durationSec: Number,
  hangupCause: String,
  transcript: [{ _id: false, role: { type: String, enum: ['user', 'assistant'] }, content: String }],
  // Pulled out of the conversation by the voice worker at the end of the call
  summary: { type: String, maxlength: 1000 },
  outcome: { type: String, enum: AI_OUTCOMES },
  interest: { type: String, enum: AI_INTERESTS },
  callerName: String, company: String, requirement: { type: String, maxlength: 500 },
  callbackRequested: { type: Boolean, default: false, index: true },
  callbackAt: Date, callbackNote: String,
  optOut: { type: Boolean, default: false },
  // Recording stays at VoBiz; the CRM streams it through its own access check (never hands out the VoBiz URL)
  recordingId: String, recordingUrl: String, recordingDurationSec: Number,
  // A sales person picked up the callback
  handledBy: { type: Schema.Types.ObjectId, ref: 'User' }, handledAt: Date,
  appliedToLead: { type: Boolean, default: false }, // the lead was updated from this call (done once)
}, { timestamps: true });
S.index({ createdAt: -1 });
S.index({ callbackRequested: 1, handledAt: 1, callbackAt: 1 });
export default mongoose.models.AiCall || mongoose.model('AiCall', S);
