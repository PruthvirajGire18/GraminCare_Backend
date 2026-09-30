import mongoose from 'mongoose'

const destinationSchema = new mongoose.Schema(
  {
    facilityName: { type: String, trim: true, maxlength: 160, default: '' },
    address: { type: String, trim: true, maxlength: 300, default: '' },
  },
  { _id: false },
)

const referralSchema = new mongoose.Schema(
  {
    patient: { type: mongoose.Schema.Types.ObjectId, ref: 'Patient', required: true, index: true },
    consultation: { type: mongoose.Schema.Types.ObjectId, ref: 'DoctorConsultation', required: true, index: true },
    doctor: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    ashaWorker: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    reason: { type: String, required: true, trim: true, maxlength: 2000 },
    priority: { type: String, enum: ['HIGH', 'CRITICAL'], default: 'HIGH', index: true },
    destination: { type: destinationSchema, default: () => ({}) },
    tokenHash: { type: String, required: true, unique: true, select: false },
    tokenCiphertext: { type: String, default: null, select: false },
    tokenIv: { type: String, default: null, select: false },
    tokenTag: { type: String, default: null, select: false },
    status: { type: String, enum: ['ACTIVE', 'USED', 'REVOKED', 'EXPIRED'], default: 'ACTIVE', index: true },
    expiresAt: { type: Date, required: true },
  },
  { timestamps: true },
)

// Avoid declaring a schema index for expiresAt: prior installs may have both
// plain and TTL variants, which can make index initialization fail with code 85.
// Startup removes expiresAt TTL indexes so expired referral history is retained.

export default mongoose.model('Referral', referralSchema)
