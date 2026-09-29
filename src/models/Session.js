import mongoose from 'mongoose';
const S = new mongoose.Schema({
  tokenHash: { type: String, unique: true, required: true },
  user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', index: true },
  expiresAt: { type: Date, required: true, index: { expires: 0 } },
  ip: String, device: String,
}, { timestamps: true });
export default mongoose.models.Session || mongoose.model('Session', S);
