import mongoose from 'mongoose';
const S = new mongoose.Schema({
  name: { type: String, required: true, trim: true, unique: true },
  address: String,
  latitude: { type: Number, required: true, min: -90, max: 90 },
  longitude: { type: Number, required: true, min: -180, max: 180 },
  radiusMeters: { type: Number, default: 5, min: 1 },         // must be within this to check in
  checkoutRadiusMeters: { type: Number, default: 20, min: 1 }, // leaving beyond this auto-checks-out
  status: { type: String, enum: ['ACTIVE', 'INACTIVE'], default: 'ACTIVE' },
}, { timestamps: true });
export default mongoose.models.Location || mongoose.model('Location', S);
