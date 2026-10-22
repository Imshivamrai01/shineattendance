import mongoose from 'mongoose';
const { Schema } = mongoose;
// Media library for WhatsApp template headers (brochure PDFs, images, videos). The file lives at WhatsApp,
// which keeps an uploaded file for 30 days; after that it has to be uploaded again.
const S = new Schema({
  kind: { type: String, enum: ['IMAGE', 'VIDEO', 'DOCUMENT'], required: true },
  name: { type: String, required: true, trim: true, maxlength: 200 }, // file name, also shown to the customer for documents
  mime: String, size: Number,
  waMediaId: { type: String, required: true },
  phoneId: String, // the sender number it was uploaded for (media ids belong to one number)
  expiresAt: { type: Date, index: true },
  uploadedBy: { type: Schema.Types.ObjectId, ref: 'User' },
}, { timestamps: true });
S.index({ createdAt: -1 });
export default mongoose.models.WaMedia || mongoose.model('WaMedia', S);
