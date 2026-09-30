import mongoose from 'mongoose'

const auditEventSchema = new mongoose.Schema(
  {
    actor: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    action: { type: String, enum: ['CONFLICT_DETECTED', 'CONFLICT_REVIEWED', 'CONFLICT_RESOLVED'], required: true },
    resource: { type: String, required: true },
    resourceId: { type: mongoose.Schema.Types.ObjectId, required: true },
    timestamp: { type: Date, required: true },
    resolution: { type: String, enum: ['KEEP_CURRENT', 'USE_INCOMING', 'CUSTOM'], default: null },
  },
  { _id: false },
)

const auditLogSchema = new mongoose.Schema(
  {
    actor: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    action: { type: String, required: true, enum: ['CONFLICT_DETECTED', 'CONFLICT_REVIEWED', 'CONFLICT_RESOLVED'] },
    patientId: { type: mongoose.Schema.Types.ObjectId, ref: 'Patient', required: true, index: true },
    recordType: { type: String, enum: ['PATIENT', 'ASHA_VISIT'], required: true },
    recordId: { type: mongoose.Schema.Types.ObjectId, required: true },
    conflictId: { type: mongoose.Schema.Types.ObjectId, ref: 'ConflictRecord', required: true, unique: true },
    resolution: { type: String, enum: ['KEEP_CURRENT', 'USE_INCOMING', 'CUSTOM'], default: null },
    events: {
      detected: auditEventSchema,
      reviewed: auditEventSchema,
      resolved: auditEventSchema,
    },
  },
  { timestamps: true },
)

export default mongoose.model('AuditLog', auditLogSchema)
