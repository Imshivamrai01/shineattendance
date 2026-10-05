import mongoose from 'mongoose';
const { Schema } = mongoose;
// Log of WhatsApp messages sent from the CRM page (one row per recipient).
const S = new Schema({
  batch: { type: String, index: true }, // one bulk send
  purpose: String, // INTERVIEW | WELCOME | BULK
  to: { type: String, required: true },
  name: String,
  user: { type: Schema.Types.ObjectId, ref: 'User' }, // set when the recipient is an employee
  template: String, language: String, params: [String],
  status: { type: String, enum: ['SENT', 'FAILED'], required: true },
  waId: String, error: String,
  sentBy: { type: Schema.Types.ObjectId, ref: 'User' },
}, { timestamps: true });
S.index({ createdAt: -1 });
export default mongoose.models.WaMessage || mongoose.model('WaMessage', S);
