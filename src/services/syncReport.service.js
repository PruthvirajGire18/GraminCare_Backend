import SyncDeviceReport from '../models/SyncDeviceReport.js'
import ApiError from '../utils/ApiError.js'

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

export async function reportSyncQueue(workerId, input = {}) {
  if (typeof input.deviceId !== 'string' || !UUID_PATTERN.test(input.deviceId)) {
    throw new ApiError(400, 'A valid device id is required')
  }
  if (!Number.isInteger(input.pendingOperations) || input.pendingOperations < 0 || input.pendingOperations > 100000) {
    throw new ApiError(400, 'Pending operation count must be a whole number from 0 to 100000')
  }

  await SyncDeviceReport.updateOne(
    { worker: workerId, deviceId: input.deviceId },
    { $set: { pendingOperations: input.pendingOperations, reportedAt: new Date() } },
    { upsert: true, runValidators: true, setDefaultsOnInsert: true },
  )
  return { accepted: true }
}
