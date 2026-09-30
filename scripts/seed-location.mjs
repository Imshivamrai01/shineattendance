// Creates the office location (from the shared Google Maps pin). Safe to re-run.
//   npm run seed:location
import mongoose from 'mongoose';
import Location from '../src/models/Location.js';
import AuditLog from '../src/models/AuditLog.js';

const uri = process.env.MONGODB_URI;
if (!uri) { console.error('MONGODB_URI must be set.'); process.exit(1); }

const OFFICE = {
  name: 'Shine Infosolutions Office',
  address: 'https://maps.app.goo.gl/8wxUr2r714z7GFPu7',
  latitude: 26.7294757,
  longitude: 83.3835677,
  radiusMeters: 15,         // must be within 15 m to check in
  checkoutRadiusMeters: 20, // beyond 20 m => automatic check-out
};

await mongoose.connect(uri, { serverSelectionTimeoutMS: 8000 });
try {
  await Location.init();
  if (await Location.findOne({ name: OFFICE.name })) {
    console.log('Office location already exists. Nothing changed.');
  } else {
    const l = await Location.create(OFFICE);
    await AuditLog.create({ action: 'CREATED_LOCATION', actorRole: 'ADMIN', entityType: 'Location', entityId: String(l._id), location: l._id,
      newData: OFFICE, reason: 'Initial setup script' });
    console.log(`Office location created at ${OFFICE.latitude}, ${OFFICE.longitude}.`);
  }
} finally {
  await mongoose.disconnect();
}
