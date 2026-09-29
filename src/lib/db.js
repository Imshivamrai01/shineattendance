import mongoose from 'mongoose';
import '../models/User.js';
import '../models/Department.js';
import '../models/Location.js';
import '../models/Attendance.js';
import '../models/ChangeRequest.js';
import '../models/AuditLog.js';
import '../models/ProfileVersion.js';
import '../models/Session.js';
import '../models/Setting.js';
import '../models/Counter.js';

const g = globalThis;
g.__mongo ||= { conn: null, promise: null };

export async function connect() {
  if (g.__mongo.conn) return g.__mongo.conn;
  const uri = process.env.MONGODB_URI;
  if (!uri) throw new Error('MONGODB_URI is not configured');
  g.__mongo.promise ||= mongoose.connect(uri, { serverSelectionTimeoutMS: 8000 });
  try {
    g.__mongo.conn = await g.__mongo.promise;
  } catch (e) {
    g.__mongo.promise = null;
    throw e;
  }
  return g.__mongo.conn;
}

export const M = {
  get User() { return mongoose.models.User; },
  get Department() { return mongoose.models.Department; },
  get Location() { return mongoose.models.Location; },
  get Attendance() { return mongoose.models.Attendance; },
  get ChangeRequest() { return mongoose.models.ChangeRequest; },
  get AuditLog() { return mongoose.models.AuditLog; },
  get ProfileVersion() { return mongoose.models.ProfileVersion; },
  get Session() { return mongoose.models.Session; },
  get Setting() { return mongoose.models.Setting; },
  get Counter() { return mongoose.models.Counter; },
};

export async function getSettings() {
  return (await M.Setting.findOneAndUpdate({ key: 'system' }, { $setOnInsert: { key: 'system' } },
    { upsert: true, new: true })).toObject();
}
