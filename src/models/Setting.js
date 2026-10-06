import mongoose from 'mongoose';
// Single-document settings store (key = 'system').
const S = new mongoose.Schema({
  key: { type: String, unique: true, default: 'system' },
  defaultRadiusMeters: { type: Number, default: 5 },
  workStart: { type: String, default: '10:00' }, workEnd: { type: String, default: '18:00' }, graceMinutes: { type: Number, default: 0 },
  lunchStart: { type: String, default: '13:30' }, lunchEnd: { type: String, default: '14:30' },
  enforceGeofence: { type: Boolean, default: true },
  radiusConfigured: { type: Boolean, default: false },
  sheetScriptUrl: String, sheetScriptSecret: String, sheetTab: { type: String, default: 'Attendance' },
  notificationEmail: String,
  // WhatsApp Cloud API (CRM page). The token never leaves the server.
  waPhoneId: String, waBusinessId: String, waToken: String,
  lastSheetSync: Date, lastMailError: String, mailEveryCheckin: { type: Boolean, default: false }, lastAbsentMailDate: String, lastMailErrorAt: Date, lastSheetError: String, lastSheetErrorAt: Date,
}, { timestamps: true });
export default mongoose.models.Setting || mongoose.model('Setting', S);
