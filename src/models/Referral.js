import mongoose from 'mongoose'

const referralSchema = new mongoose.Schema(
  {
    patient: { type: mongoose.Schema.Types.ObjectId, ref: 'Patient', required: true, index: true },
    consultation: { type: mongoose.Schema.Types.ObjectId, ref: 'DoctorConsultation', required: true, index: true },
    doctor: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    ashaWorker: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    reason: { type: String, required: true, trim: true, maxlength: 2000 },
    tokenHash: { type: String, required: true, unique: true, select: false },
    status: { type: String, enum: ['ACTIVE', 'USED', 'REVOKED', 'EXPIRED'], default: 'ACTIVE', index: true },
    expiresAt: { type: Date, required: true },
  },
  { timestamps: true },
)

// Do not redeclare the legacy expiresAt index here: deployed databases have
// both plain and TTL variants, and MongoDB rejects an option mismatch (85).
// Expiration is enforced by referral queries; existing database indexes remain.

export default mongoose.model('Referral', referralSchema)
