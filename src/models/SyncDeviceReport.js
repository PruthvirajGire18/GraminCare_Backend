import mongoose from 'mongoose'

const syncDeviceReportSchema = new mongoose.Schema(
  {
    worker: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    deviceId: { type: String, required: true, minlength: 36, maxlength: 36 },
    pendingOperations: { type: Number, required: true, min: 0, max: 100000 },
    reportedAt: { type: Date, required: true, default: Date.now },
  },
  { timestamps: true, versionKey: false },
)

syncDeviceReportSchema.index({ worker: 1, deviceId: 1 }, { unique: true })
syncDeviceReportSchema.index({ reportedAt: -1 })

export default mongoose.model('SyncDeviceReport', syncDeviceReportSchema)
