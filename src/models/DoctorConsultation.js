import mongoose from 'mongoose'

const doctorConsultationSchema = new mongoose.Schema(
  {
    patient: { type: mongoose.Schema.Types.ObjectId, ref: 'Patient', required: true, index: true },
    ashaVisit: { type: mongoose.Schema.Types.ObjectId, ref: 'ASHAVisit', default: null },
    doctor: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    notes: { type: String, required: true, trim: true, maxlength: 10000 },
    assessment: { type: String, trim: true, maxlength: 5000, default: '' },
    treatmentPlan: { type: String, trim: true, maxlength: 5000, default: '' },
    priority: { type: String, enum: ['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'], default: 'LOW' },
    followUpDate: { type: Date, default: null },
    followUpStatus: { type: String, enum: ['PENDING', 'COMPLETED', 'MISSED'], default: null, index: true },
    followUpVisit: { type: mongoose.Schema.Types.ObjectId, ref: 'ASHAVisit', default: null },
  },
  { timestamps: true },
)

doctorConsultationSchema.index({ doctor: 1, createdAt: -1 })
doctorConsultationSchema.index({ patient: 1, followUpStatus: 1, followUpDate: 1 })

export default mongoose.model('DoctorConsultation', doctorConsultationSchema)
