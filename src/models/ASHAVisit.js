import mongoose from 'mongoose'

const vitalsSchema = new mongoose.Schema(
  {
    temperatureC: { type: Number, min: 25, max: 45, default: null },
    heartRateBpm: { type: Number, min: 20, max: 250, default: null },
    respiratoryRatePerMinute: { type: Number, min: 4, max: 80, default: null },
    systolicMmHg: { type: Number, min: 40, max: 300, default: null },
    diastolicMmHg: { type: Number, min: 20, max: 200, default: null },
    oxygenSaturationPercent: { type: Number, min: 50, max: 100, default: null },
    weightKg: { type: Number, min: 0.3, max: 500, default: null },
    heightCm: { type: Number, min: 20, max: 250, default: null },
  },
  { _id: false },
)

const followUpVisitSchema = new mongoose.Schema(
  {
    date: { type: Date, default: null },
    status: { type: String, enum: ['NOT_SCHEDULED', 'SCHEDULED', 'COMPLETED'], default: 'NOT_SCHEDULED' },
    completedByVisit: { type: mongoose.Schema.Types.ObjectId, ref: 'ASHAVisit', default: null },
  },
  { _id: false },
)

const aiAssessmentSchema = new mongoose.Schema(
  {
    status: { type: String, enum: ['AI_ASSESSMENT_PENDING', 'AI_ASSESSMENT_PROCESSING', 'AI_ASSESSED'], default: 'AI_ASSESSMENT_PENDING' },
    riskLevel: { type: String, enum: ['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'], default: null },
    riskScore: { type: Number, min: 0, max: 100, default: null },
    priority: { type: String, enum: ['ROUTINE', 'NORMAL', 'URGENT', 'EMERGENCY'], default: null },
    factors: { type: [{ type: String, trim: true, maxlength: 240 }], default: [] },
    recommendation: { type: String, trim: true, maxlength: 1000, default: '' },
    assessedAt: { type: Date, default: null },
    mode: { type: String, enum: ['mock', 'openai'], default: null },
    model: { type: String, maxlength: 120, default: null },
    attempts: { type: Number, min: 0, default: 0 },
    nextAttemptAt: { type: Date, default: Date.now },
    lastErrorCode: { type: String, maxlength: 80, default: null },
  },
  { _id: false },
)

const ashaVisitSchema = new mongoose.Schema(
  {
    patient: { type: mongoose.Schema.Types.ObjectId, ref: 'Patient', required: true, immutable: true, index: true },
    ashaWorker: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, immutable: true, index: true },
    version: { type: Number, required: true, min: 1, default: 1 },
    updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    fieldUpdatedBy: { type: Map, of: mongoose.Schema.Types.ObjectId, ref: 'User', default: () => new Map() },
    clientOperationId: { type: String, required: true, trim: true, maxlength: 128 },
    visitType: { type: String, enum: ['INITIAL', 'FOLLOW_UP'], required: true, default: 'INITIAL' },
    visitDate: { type: Date, required: true, default: Date.now },
    followUpOf: { type: mongoose.Schema.Types.ObjectId, ref: 'ASHAVisit', default: null, index: true },
    followUpConsultation: { type: mongoose.Schema.Types.ObjectId, ref: 'DoctorConsultation', default: null },
    symptoms: {
      chiefComplaint: { type: String, required: true, trim: true, maxlength: 1000 },
      details: { type: String, trim: true, maxlength: 4000, default: '' },
      durationDays: { type: Number, min: 0, max: 365, default: null, validate: { validator: (value) => value === null || Number.isInteger(value), message: 'Symptom duration must be a whole number of days' } },
    },
    medicalHistory: { type: [{ type: String, trim: true, maxlength: 300 }], default: [] },
    allergies: { type: [{ type: String, trim: true, maxlength: 200 }], default: [] },
    currentMedicines: { type: [{ type: String, trim: true, maxlength: 200 }], default: [] },
    vitals: { type: vitalsSchema, default: () => ({}) },
    observations: { type: String, trim: true, maxlength: 4000, default: '' },
    followUp: { type: followUpVisitSchema, default: () => ({}) },
    // Assessments are doctor-only; hide even their status from every ASHA query by default.
    aiAssessment: { type: aiAssessmentSchema, default: () => ({}), select: false },
  },
  { timestamps: true, optimisticConcurrency: true },
)

ashaVisitSchema.set('toJSON', {
  transform(_document, result) {
    delete result.aiAssessment
    return result
  },
})

ashaVisitSchema.index({ ashaWorker: 1, visitDate: -1 })
ashaVisitSchema.index({ ashaWorker: 1, 'followUp.status': 1, 'followUp.date': 1 })
ashaVisitSchema.index({ 'aiAssessment.status': 1, 'aiAssessment.nextAttemptAt': 1 })
ashaVisitSchema.index(
  { followUpConsultation: 1 },
  { unique: true, partialFilterExpression: { followUpConsultation: { $type: 'objectId' } } },
)
ashaVisitSchema.index(
  { ashaWorker: 1, clientOperationId: 1 },
  { unique: true, partialFilterExpression: { clientOperationId: { $type: 'string' } } },
)

export default mongoose.model('ASHAVisit', ashaVisitSchema)
