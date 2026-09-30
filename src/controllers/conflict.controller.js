import { listPendingConflicts, resolveConflict } from '../services/conflict.service.js'
import { enqueueRiskAssessment } from '../services/aiRiskQueue.service.js'

export async function getPendingConflicts(_request, response) {
  const conflicts = await listPendingConflicts()
  response.status(200).json({ success: true, conflicts })
}

export async function resolvePendingConflict(request, response) {
  const conflict = await resolveConflict(request.params.conflictId, request.body, request.user._id.toString())
  if (conflict.recordType === 'ASHA_VISIT' && conflict.resolution !== 'KEEP_CURRENT') {
    enqueueRiskAssessment(conflict.recordId)
  }
  response.status(200).json({ success: true, conflict })
}
