import mongoose from 'mongoose';
const { Schema } = mongoose;
// Timeline of a lead: calls, follow-ups, notes, status / owner changes, and being found again by the lead finder.
const S = new Schema({
  lead: { type: Schema.Types.ObjectId, ref: 'Lead', required: true, index: true },
  type: { type: String, enum: ['CREATED', 'CALL', 'AI_CALL', 'FOLLOW_UP', 'NOTE', 'STATUS', 'ASSIGN', 'EDIT', 'FOUND_AGAIN'], required: true },
  outcome: String, // CALL: CONNECTED | CALL_BACK | NO_ANSWER | CALL_CUT | BUSY | SWITCHED_OFF | WRONG_NUMBER, or PENDING until the caller fills it in
  note: { type: String, trim: true, maxlength: 2000 },
  // CALL started from the Call button: when it was dialled, when the outcome was saved, rough length (time away from the app)
  viaApp: Boolean, endedAt: Date, durationSec: Number, phone: String,
  followUpAt: Date,
  from: String, to: String, // STATUS / ASSIGN
  aiCall: { type: Schema.Types.ObjectId, ref: 'AiCall' }, // AI_CALL
  // CALL made through the office line (the caller's phone rang first, then the lead): live status, recording, transcript, summary
  bridge: {
    callId: { type: String, index: true, sparse: true },
    status: { type: String, enum: ['CALLING_AGENT', 'AGENT_NO_ANSWER', 'RINGING_LEAD', 'CONNECTED', 'ENDED', 'NO_ANSWER', 'BUSY', 'FAILED'] },
    leadAnsweredAt: Date, talkSec: Number, reason: String,
    recordingId: String, recordingDurationSec: Number,
    transcript: [{ _id: false, role: { type: String, enum: ['team', 'customer'] }, content: String }],
    summary: { type: String, maxlength: 1500 },
  },
  by: { type: Schema.Types.ObjectId, ref: 'User' },
}, { timestamps: true });
S.index({ createdAt: -1 });
S.index({ by: 1, type: 1, createdAt: -1 });
export default mongoose.models.LeadActivity || mongoose.model('LeadActivity', S);
