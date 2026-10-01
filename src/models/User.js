import mongoose from 'mongoose'

export const USER_ROLES = ['ADMIN', 'ASHA_WORKER', 'DOCTOR']
export const USER_STATUSES = ['PENDING', 'APPROVED', 'REJECTED', 'INACTIVE']

const userSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true, minlength: 2, maxlength: 100 },
    email: { type: String, required: true, unique: true, lowercase: true, trim: true, maxlength: 254 },
    passwordHash: { type: String, required: true, select: false },
    role: { type: String, required: true, enum: USER_ROLES },
    status: { type: String, required: true, enum: USER_STATUSES, default: 'PENDING' },
    tokenVersion: { type: Number, required: true, default: 0, min: 0 },
  },
  { timestamps: true },
)

export default mongoose.model('User', userSchema)
