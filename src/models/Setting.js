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
  // Meta webhook: the verify token typed into Meta's Callback URL form, and the app secret that signs each delivery (optional)
  waVerifyToken: String, waAppSecret: String,
  // Google Places API key for the Sales lead finder (OpenStreetMap is used without it). Never sent to the browser.
  placesKey: String,
  // What the AI calling agent knows about the company (services, timings, address, FAQs). Used on every AI call.
  aiCompanyInfo: { type: String, maxlength: 4000 },
  // Live transfer from an AI call to a person: on/off, ring one by one or everyone at once, ring time, only people checked in today
  aiTransferEnabled: { type: Boolean, default: true }, aiTransferMode: { type: String, enum: ['SEQUENTIAL', 'ALL'], default: 'SEQUENTIAL' },
  aiTransferRingSec: { type: Number, default: 20 }, aiTransferNeedCheckIn: { type: Boolean, default: true },
  // Voice of the AI agent: Rumik or Sarvam (auto = Rumik, switching to Sarvam on its own if Rumik stops working) and the Sarvam voice
  aiVoiceProvider: { type: String, enum: ['auto', 'rumik', 'sarvam'], default: 'auto' }, aiSarvamSpeaker: { type: String, default: 'simran_enhi_customer' },
  aiProviderAlertAt: { type: Map, of: Date },
  // Sales Call button rings the caller's phone first, then the lead, from the company number (recorded). Off = phone dialer.
  officeLineEnabled: { type: Boolean, default: true }, // last "voice provider stopped working" alert per provider (one per hour)
  lastSheetSync: Date, lastMailError: String, mailEveryCheckin: { type: Boolean, default: false }, lastAbsentMailDate: String, lastMailErrorAt: Date, lastSheetError: String, lastSheetErrorAt: Date,
}, { timestamps: true });
export default mongoose.models.Setting || mongoose.model('Setting', S);
