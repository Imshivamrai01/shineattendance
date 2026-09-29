import mongoose from 'mongoose';
const S = new mongoose.Schema({
  name: { type: String, required: true, trim: true, unique: true },
  description: String,
  parent: { type: mongoose.Schema.Types.ObjectId, ref: 'Department' }, // e.g. INTERN > INTERN - WEB DEVELOPER
  status: { type: String, enum: ['ACTIVE', 'INACTIVE'], default: 'ACTIVE' },
}, { timestamps: true });
export default mongoose.models.Department || mongoose.model('Department', S);
