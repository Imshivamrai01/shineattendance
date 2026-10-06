import mongoose from 'mongoose';
const { Schema } = mongoose;
const point = new Schema({
  lat: Number, lng: Number, distance: Number, accuracy: Number,
  verified: Boolean, // inside geofence of the assigned location
}, { _id: false });
const session = new Schema({
  checkIn: { type: Date, required: true },
  checkOut: Date,
  inGeo: point, outGeo: point,
  corrected: { type: Boolean, default: false },
  autoCheckout: { type: Boolean, default: false },
  endOfDay: { type: Boolean, default: false }, // closed automatically at office closing time
  silent: { type: Boolean, default: false }, // closed because the phone stopped reporting its location (check-out = last report)
  reentryReason: String, // (older records) why the user came back after leaving the premises
  lastPingAt: Date, lastPingDistance: Number, // most recent location report while checked in (shows when a phone stops reporting)
  lateReason: String, // why the first check-in of the day was after office start
  // Auto check-outs that were followed by a return the same day: the session carries on and the time away is kept here.
  breaks: [new Schema({ outAt: Date, backAt: Date, distance: Number, reason: String, photo: { type: new Schema({ publicId: String, version: Number }, { _id: false }) } }, { _id: false })],
  inPhoto: { type: new Schema({ publicId: String, version: Number }, { _id: false }) },
  outPhoto: { type: new Schema({ publicId: String, version: Number }, { _id: false }) },
  outCount: { type: Number, default: 0 }, firstOutAt: Date,
}, { _id: true });

const S = new Schema({
  user: { type: Schema.Types.ObjectId, ref: 'User', required: true },
  date: { type: String, required: true }, // YYYY-MM-DD (IST)
  location: { type: Schema.Types.ObjectId, ref: 'Location' },
  sessions: [session],
  status: { type: String, enum: ['ACTIVE', 'VOIDED'], default: 'ACTIVE' },
  voidReason: String, voidedBy: { type: Schema.Types.ObjectId, ref: 'User' }, voidedAt: Date,
}, { timestamps: true });
S.index({ user: 1, date: 1 }, { unique: true });
export default mongoose.models.Attendance || mongoose.model('Attendance', S);
