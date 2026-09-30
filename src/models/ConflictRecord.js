import mongoose from 'mongoose'

const conflictRecordSchema = new mongoose.Schema(
  {
    patientId: { type: mongoose.Schema.Types.ObjectId, ref: 'Patient', required: true, index: true },
    recordType: { type: String, enum: ['PATIENT', 'ASHA_VISIT'], required: true },
    recordId: { type: mongoose.Schema.Types.ObjectId, required: true, index: true },
    field: { type: String, required: true, trim: true, maxlength: 120 },
    oldValue: { type: mongoose.Schema.Types.Mixed, default: null },
    incomingValue: { type: mongoose.Schema.Types.Mixed, default: null },
    currentValue: { type: mongoose.Schema.Types.Mixed, default: null },
    conflictingUser: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    currentUser: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    clientOperationId: { type: String, required: true, trim: true, maxlength: 128 },
    baseVersion: { type: Number, required: true },
    currentVersion: { type: Number, required: true },
    status: { type: String, enum: ['PENDING', 'RESOLVED'], default: 'PENDING', index: true },
    resolvedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    resolution: { type: String, enum: ['KEEP_CURRENT', 'USE_INCOMING', 'CUSTOM'], default: null },
    resolvedValue: { type: mongoose.Schema.Types.Mixed, default: null },
    resolvedAt: { type: Date, default: null },
  },
  { timestamps: true, optimisticConcurrency: true },
)

conflictRecordSchema.index(
  { recordType: 1, recordId: 1, clientOperationId: 1, field: 1 },
  { unique: true },
)
conflictRecordSchema.index({ status: 1, createdAt: -1 })

export default mongoose.model('ConflictRecord', conflictRecordSchema)
