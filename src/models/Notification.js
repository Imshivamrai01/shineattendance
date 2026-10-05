import mongoose from 'mongoose';
const { Schema } = mongoose;
// In-app notification (the bell at the top of the app). Unread ones are listed; reading one clears it from the list.
const S = new Schema({
  user: { type: Schema.Types.ObjectId, ref: 'User', required: true },
  title: { type: String, required: true, maxlength: 140 },
  body: { type: String, maxlength: 500 },
  link: String, // page to open when tapped
  readAt: Date,
  createdAt: { type: Date, default: Date.now, expires: 60 * 24 * 3600 }, // cleaned up after 60 days
});
S.index({ user: 1, readAt: 1, createdAt: -1 });
export default mongoose.models.Notification || mongoose.model('Notification', S);
