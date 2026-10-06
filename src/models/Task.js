import mongoose from 'mongoose';
const { Schema } = mongoose;
// A daily task assigned by HR (or above) to one person. The person reports on it before checking out; HR then approves it or not.
const S = new Schema({
  user: { type: Schema.Types.ObjectId, ref: 'User', required: true },
  date: { type: String, required: true }, // YYYY-MM-DD (IST) the task is due
  title: { type: String, required: true, trim: true, maxlength: 200 },
  details: { type: String, trim: true, maxlength: 2000 },
  assignedBy: { type: Schema.Types.ObjectId, ref: 'User', required: true },
  // PENDING (no update yet) -> SUBMITTED (the assignee wrote their update) -> DONE / NOT_DONE (decided by HR or above)
  status: { type: String, enum: ['PENDING', 'SUBMITTED', 'DONE', 'NOT_DONE'], default: 'PENDING' },
  // The assignee's own report, required before they check out for the day.
  update: { type: new Schema({ text: String, done: Boolean, at: Date }, { _id: false }) },
  // Not finished on its day (marked not done, never updated, or done on a later day): shown as late submission, scores 0.
  late: { type: Boolean, default: false },
  note: { type: String, trim: true, maxlength: 500 }, // HR's progress remark
  reviewedBy: { type: Schema.Types.ObjectId, ref: 'User' },
  reviewedAt: Date,
}, { timestamps: true });
S.index({ user: 1, date: -1 });
S.index({ date: 1, status: 1 });
export default mongoose.models.Task || mongoose.model('Task', S);
