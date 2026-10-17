import mongoose from 'mongoose';
const { Schema } = mongoose;
// One run of the lead finder.
const S = new Schema({
  location: String, category: String, source: { type: String, enum: ['GOOGLE', 'OSM'] },
  found: { type: Number, default: 0 }, // results returned by the source
  created: { type: Number, default: 0 }, // new leads saved
  repeated: { type: Number, default: 0 }, // already in the CRM
  skipped: { type: Number, default: 0 }, // no phone number (when only leads with a phone were wanted)
  error: String, ms: Number,
  by: { type: Schema.Types.ObjectId, ref: 'User' },
}, { timestamps: true });
S.index({ createdAt: -1 });
export default mongoose.models.ScrapeJob || mongoose.model('ScrapeJob', S);
