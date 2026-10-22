import mongoose from 'mongoose';
const { Schema } = mongoose;
// Log of WhatsApp messages sent from the CRM page (one row per recipient), with delivery updates and replies from the Meta webhook.
const S = new Schema({
  batch: { type: String, index: true }, // one bulk send
  purpose: String, // INTERVIEW | WELCOME | BULK
  to: { type: String, required: true },
  name: String,
  user: { type: Schema.Types.ObjectId, ref: 'User' }, // set when the recipient is an employee
  template: String, language: String, params: [String],
  status: { type: String, enum: ['SENT', 'DELIVERED', 'READ', 'FAILED', 'RECEIVED'], required: true },
  waId: String, error: String,
  direction: { type: String, enum: ['OUT', 'IN'], default: 'OUT' }, text: String, // IN = a reply someone sent to the business number
  deliveredAt: Date, readAt: Date,
  sentBy: { type: Schema.Types.ObjectId, ref: 'User' },
}, { timestamps: true });
S.index({ createdAt: -1 });
S.index({ waId: 1 });
export default mongoose.models.WaMessage || mongoose.model('WaMessage', S);
