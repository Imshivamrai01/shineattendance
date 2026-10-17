import mongoose from 'mongoose';
const { Schema } = mongoose;

export const LEAD_STATUSES = ['NEW', 'CONTACTED', 'FOLLOW_UP', 'INTERESTED', 'CONVERTED', 'NOT_INTERESTED', 'INVALID'];

// A sales lead, found by the lead finder (Google / OpenStreetMap) or added by hand.
// The same business is never stored twice: finding it again bumps `timesFound` (shown as a Repeat lead).
const S = new Schema({
  name: { type: String, required: true, trim: true, maxlength: 200 },
  phone: { type: String, trim: true }, // as shown
  phoneKey: { type: String, index: true }, // digits only, Indian numbers as their last 10 digits (dedupe key)
  altPhones: [String],
  address: { type: String, trim: true }, area: String, city: String,
  category: { type: String, trim: true, index: true }, // what was searched for (restaurant, gym, ...)
  searchLocation: String,
  instagram: { type: String, index: true, sparse: true }, // https://instagram.com/<handle>, lower case (also a dedupe key)
  website: String, email: String, mapsUrl: String,
  rating: Number, reviews: Number, lat: Number, lng: Number,
  source: { type: String, enum: ['GOOGLE', 'OSM', 'MANUAL'], default: 'MANUAL' },
  sourceId: { type: String, index: true, sparse: true }, // Google place id / OSM element id
  nameKey: { type: String, index: true }, // normalised name + rough position (dedupe key for leads without a phone)
  status: { type: String, enum: LEAD_STATUSES, default: 'NEW', index: true },
  // Lead quality, recomputed on every change (lib/sales.js scoreLead)
  score: { type: Number, default: 0 }, grade: { type: String, enum: ['HOT', 'WARM', 'COLD'], default: 'COLD', index: true }, scoreNotes: [String],
  assignedTo: { type: Schema.Types.ObjectId, ref: 'User', index: true },
  createdBy: { type: Schema.Types.ObjectId, ref: 'User' },
  timesFound: { type: Number, default: 1, index: true }, firstFoundAt: Date, lastFoundAt: Date,
  scrapes: [{ type: Schema.Types.ObjectId, ref: 'ScrapeJob' }],
  callCount: { type: Number, default: 0 }, connectedCount: { type: Number, default: 0 },
  lastCallAt: Date, lastCallBy: { type: Schema.Types.ObjectId, ref: 'User' }, lastOutcome: String,
  nextFollowUpAt: { type: Date, index: true },
  lastActivityAt: Date,
  notes: { type: String, trim: true, maxlength: 2000 },
}, { timestamps: true });
S.index({ updatedAt: -1 });
export default mongoose.models.Lead || mongoose.model('Lead', S);
