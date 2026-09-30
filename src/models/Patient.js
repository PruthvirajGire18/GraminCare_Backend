import mongoose from 'mongoose'

const addressSchema = new mongoose.Schema(
  {
    village: { type: String, trim: true, maxlength: 120, default: '' },
    district: { type: String, trim: true, maxlength: 120, default: '' },
    state: { type: String, trim: true, maxlength: 120, default: '' },
    details: { type: String, trim: true, maxlength: 300, default: '' },
  },
  { _id: false },
)

const patientSchema = new mongoose.Schema(
  {
    fullName: { type: String, required: true, trim: true, minlength: 2, maxlength: 120, index: true },
    dateOfBirth: { type: Date, default: null, validate: { validator: (date) => !date || date <= new Date(), message: 'Date of birth cannot be in the future' } },
    gender: { type: String, required: true, enum: ['FEMALE', 'MALE', 'OTHER', 'UNKNOWN'] },
    phone: { type: String, trim: true, maxlength: 25, default: '' },
    address: { type: addressSchema, default: () => ({}) },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, immutable: true, index: true },
    ashaWorkers: { type: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }], default: [] },
    version: { type: Number, required: true, min: 1, default: 1 },
    updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    fieldUpdatedBy: { type: Map, of: mongoose.Schema.Types.ObjectId, ref: 'User', default: () => new Map() },
    clientOperationId: { type: String, required: true, trim: true, maxlength: 128 },
    status: { type: String, enum: ['ACTIVE', 'ARCHIVED'], default: 'ACTIVE', index: true },
    caseStatus: { type: String, enum: ['NEW', 'ACTIVE'], default: 'NEW', select: false, index: true },
    assignedDoctor: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null, select: false, index: true },
    assignedAt: { type: Date, default: null, select: false },
  },
  { timestamps: true, optimisticConcurrency: true },
)

patientSchema.set('toJSON', {
  transform(_document, result) {
    delete result.caseStatus
    delete result.assignedDoctor
    delete result.assignedAt
    return result
  },
})

patientSchema.index({ createdBy: 1, fullName: 1, status: 1 })
patientSchema.index({ ashaWorkers: 1, fullName: 1, status: 1 })
patientSchema.index({ status: 1, caseStatus: 1, assignedDoctor: 1, createdAt: -1 })
patientSchema.index(
  { createdBy: 1, clientOperationId: 1 },
  { unique: true, partialFilterExpression: { clientOperationId: { $type: 'string' } } },
)

export default mongoose.model('Patient', patientSchema)
