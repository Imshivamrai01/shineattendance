import mongoose from 'mongoose';
const { Schema } = mongoose;
// One row per (user, field, version): full history of every tracked profile field.
const S = new Schema({
  user: { type: Schema.Types.ObjectId, ref: 'User', index: true, required: true },
  field: { type: String, required: true },
  version: { type: Number, required: true },
  value: Schema.Types.Mixed,
  changedBy: { type: Schema.Types.ObjectId, ref: 'User' },
  changedByRole: String,
  reason: String,
  at: { type: Date, default: Date.now },
}, { versionKey: false });
S.index({ user: 1, field: 1, version: 1 }, { unique: true });
export default mongoose.models.ProfileVersion || mongoose.model('ProfileVersion', S);
