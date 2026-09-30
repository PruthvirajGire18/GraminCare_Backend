import mongoose from 'mongoose'

const prescriptionItemSchema = new mongoose.Schema(
  {
    medicine: { type: String, required: true, trim: true, maxlength: 200 },
    dosage: { type: String, required: true, trim: true, maxlength: 120 },
    frequency: { type: String, required: true, trim: true, maxlength: 120 },
    duration: { type: String, trim: true, maxlength: 120, default: '' },
    instructions: { type: String, trim: true, maxlength: 500, default: '' },
  },
  { _id: false },
)

const prescriptionSchema = new mongoose.Schema(
  {
    patient: { type: mongoose.Schema.Types.ObjectId, ref: 'Patient', required: true, index: true },
    consultation: { type: mongoose.Schema.Types.ObjectId, ref: 'DoctorConsultation', required: true, index: true },
    doctor: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    items: { type: [prescriptionItemSchema], required: true, validate: { validator: (items) => items.length > 0, message: 'A prescription must have at least one medicine' } },
    notes: { type: String, trim: true, maxlength: 2000, default: '' },
  },
  { timestamps: true },
)

export default mongoose.model('Prescription', prescriptionSchema)
