import mongoose from 'mongoose';
const { Schema } = mongoose;

export const AI_KINDS = ['SALES', 'INTERVIEW', 'FEEDBACK', 'ATTENDANCE', 'OTHER'];

// A call type for the AI agent ("Sales", "Interview invite", "Feedback"): what it says first, how to pitch,
// and what to find out. Edited in plain words by the team; the agent reads it at the start of every call.
const S = new Schema({
  name: { type: String, required: true, trim: true, maxlength: 60 },
  kind: { type: String, enum: AI_KINDS, default: 'OTHER' }, // SALES calls create / update sales leads; the others don't
  opening: { type: String, trim: true, maxlength: 300 }, // first sentence; {name} = the person's first name
  instructions: { type: String, trim: true, maxlength: 3000 }, // the pitch: what to say, offers, answers to common questions
  collect: { type: String, trim: true, maxlength: 600 }, // what to find out on the call
  active: { type: Boolean, default: true },
  updatedBy: { type: Schema.Types.ObjectId, ref: 'User' },
}, { timestamps: true });
export default mongoose.models.AiScript || mongoose.model('AiScript', S);
