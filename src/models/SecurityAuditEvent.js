import mongoose from 'mongoose'

const auditEventSchema = new mongoose.Schema(
  {
    actor: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    actorRole: { type: String, enum: ['ADMIN', 'ASHA_WORKER', 'DOCTOR'], required: true },
    action: {
      type: String,
      enum: [
        'LOGIN', 'LOGOUT', 'USER_APPROVED', 'USER_REJECTED', 'USER_STATUS_CHANGED',
        'PATIENT_CREATED', 'PATIENT_UPDATED', 'PATIENT_SHARED', 'PATIENT_ARCHIVED',
        'VISIT_CREATED', 'VISIT_UPDATED', 'SYNC_COMPLETED',
        'CASE_ASSIGNED', 'CONSULTATION_CREATED', 'PRESCRIPTION_CREATED',
      ],
      required: true,
      index: true,
    },
    resourceType: {
      type: String,
      enum: ['AUTH', 'USER', 'PATIENT', 'ASHA_VISIT', 'CASE', 'CONSULTATION', 'PRESCRIPTION'],
      required: true,
    },
    resourceId: { type: mongoose.Schema.Types.ObjectId, default: null, index: true },
    occurredAt: { type: Date, required: true, default: Date.now, index: true },
  },
  { versionKey: false, strict: 'throw' },
)

auditEventSchema.index({ resourceType: 1, resourceId: 1, occurredAt: -1 })

export default mongoose.model('SecurityAuditEvent', auditEventSchema)
