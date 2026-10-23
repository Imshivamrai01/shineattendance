import mongoose from 'mongoose';
const { Schema } = mongoose;

export const LIST_KINDS = ['INTERVIEW', 'FEEDBACK'];
// Where each person on a list stands. Interview: invited -> confirmed / declined. Feedback: asked -> done.
export const CONTACT_STATUSES = ['NEW', 'CALLED', 'NO_ANSWER', 'CONFIRMED', 'DECLINED', 'RESCHEDULE', 'DONE', 'COMPLAINT'];

// A CRM list of people who are not employees or sales leads: interview candidates for one role,
// or customers to ask for feedback. Each person can get an IVR call, an AI call or a WhatsApp message.
const contact = new Schema({
  name: { type: String, trim: true, maxlength: 120 },
  phone: { type: String, trim: true, maxlength: 30 },
  status: { type: String, enum: CONTACT_STATUSES, default: 'NEW' },
  note: { type: String, trim: true, maxlength: 1000 }, // what they said (AI summary or typed after a call)
  rating: Number, // feedback calls: 1-5
  lastCallAt: Date, lastMessageAt: Date,
}, { timestamps: true });

const S = new Schema({
  kind: { type: String, enum: LIST_KINDS, required: true, index: true },
  title: { type: String, required: true, trim: true, maxlength: 120 }, // the role ("Sales Executive") or the customer group
  // Interview: date, time and venue (told on AI calls and filled into the WhatsApp invite). Feedback: the service.
  date: { type: String, trim: true, maxlength: 60 }, time: { type: String, trim: true, maxlength: 40 },
  venue: { type: String, trim: true, maxlength: 200 }, details: { type: String, trim: true, maxlength: 500 },
  contacts: [contact],
  archived: { type: Boolean, default: false },
  createdBy: { type: Schema.Types.ObjectId, ref: 'User' },
}, { timestamps: true });
S.index({ kind: 1, archived: 1, createdAt: -1 });
export default mongoose.models.ContactList || mongoose.model('ContactList', S);
