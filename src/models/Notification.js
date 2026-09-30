import mongoose from 'mongoose'

const notificationSchema = new mongoose.Schema(
  {
    recipient: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    recipientRole: { type: String, enum: ['DOCTOR', 'ASHA_WORKER'], required: true },
    type: { type: String, enum: ['FOLLOW_UP_DUE', 'FOLLOW_UP_MISSED', 'FOLLOW_UP_COMPLETED'], required: true },
    title: { type: String, required: true, trim: true, maxlength: 120 },
    message: { type: String, required: true, trim: true, maxlength: 300 },
    patient: { type: mongoose.Schema.Types.ObjectId, ref: 'Patient', required: true, index: true },
    consultation: { type: mongoose.Schema.Types.ObjectId, ref: 'DoctorConsultation', required: true },
    visit: { type: mongoose.Schema.Types.ObjectId, ref: 'ASHAVisit', default: null },
    dueDate: { type: Date, required: true },
    dedupeKey: { type: String, required: true, unique: true, select: false },
    resolvedAt: { type: Date, default: null },
  },
  { timestamps: true },
)

notificationSchema.index({ recipient: 1, createdAt: -1 })

export default mongoose.model('Notification', notificationSchema)
