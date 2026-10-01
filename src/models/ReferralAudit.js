import mongoose from 'mongoose'

const referralAuditSchema = new mongoose.Schema(
  {
    referral: { type: mongoose.Schema.Types.ObjectId, ref: 'Referral', required: true, index: true },
    patient: { type: mongoose.Schema.Types.ObjectId, ref: 'Patient', required: true, index: true },
    actor: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    actorRole: { type: String, enum: ['ADMIN', 'ASHA_WORKER', 'DOCTOR'], default: null },
    action: {
      type: String,
      enum: ['REFERRAL_CREATED', 'REFERRAL_VIEWED', 'REFERRAL_ACCESSED', 'REFERRAL_USED', 'REFERRAL_EXPIRED', 'REFERRAL_REVOKED'],
      required: true,
      index: true,
    },
    timestamp: { type: Date, required: true, default: Date.now },
  },
  { timestamps: true },
)

referralAuditSchema.index({ referral: 1, timestamp: -1 })

export default mongoose.model('ReferralAudit', referralAuditSchema)
