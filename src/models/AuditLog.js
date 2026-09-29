import mongoose from 'mongoose';
const { Schema } = mongoose;
const S = new Schema({
  actorId: { type: Schema.Types.ObjectId, index: true },
  actorEmail: String,
  actorRole: { type: String, index: true },
  action: { type: String, required: true, index: true },
  entityType: { type: String, index: true },
  entityId: { type: String, index: true },
  subjectId: { type: Schema.Types.ObjectId, index: true }, // employee the action concerns
  department: { type: Schema.Types.ObjectId, index: true },
  location: { type: Schema.Types.ObjectId, index: true },
  oldData: Schema.Types.Mixed,
  newData: Schema.Types.Mixed,
  reason: String,
  override: { type: Boolean, default: false },
  ip: String, device: String, requestId: String,
  at: { type: Date, default: Date.now, index: true },
}, { versionKey: false });

// Immutable: audit entries can be created but never changed or removed.
const block = function () { throw new Error('Audit log entries are immutable'); };
for (const op of ['updateOne', 'updateMany', 'findOneAndUpdate', 'findOneAndReplace', 'replaceOne',
  'deleteOne', 'deleteMany', 'findOneAndDelete']) S.pre(op, block);
S.pre('save', function (next) { if (!this.isNew) return next(new Error('Audit log entries are immutable')); next(); });

export default mongoose.models.AuditLog || mongoose.model('AuditLog', S);
