import {
  archivePatient,
  createPatient,
  createVisit,
  getDashboardSummary,
  getPatientProfile,
  getPatientVisit,
  listPatientVisits,
  listPatients,
  sharePatientWithWorker,
} from '../services/asha.service.js'
import { applyVersionedChanges } from '../services/conflict.service.js'
import { enqueueRiskAssessment } from '../services/aiRiskQueue.service.js'

function workerId(request) {
  return request.user._id.toString()
}

export async function getDashboard(request, response) {
  const summary = await getDashboardSummary(workerId(request))
  response.status(200).json({ success: true, summary })
}

export async function getPatients(request, response) {
  const result = await listPatients(workerId(request), request.query)
  response.status(200).json({ success: true, ...result })
}

export async function postPatient(request, response) {
  const result = await createPatient(request.body, workerId(request))
  response.status(result.created ? 201 : 200).json({ success: true, patient: result.patient })
}

export async function getPatient(request, response) {
  const result = await getPatientProfile(request.params.patientId, workerId(request))
  response.status(200).json({ success: true, ...result })
}

export async function patchPatient(request, response) {
  const result = await applyVersionedChanges({
    recordType: 'PATIENT',
    recordId: request.params.patientId,
    changes: request.body?.changes,
    baseValues: request.body?.baseValues,
    baseVersion: request.body?.baseVersion,
    clientOperationId: request.body?.clientOperationId,
    userId: workerId(request),
  })
  response.status(200).json({
    success: true,
    patient: result.record,
    conflicts: result.conflicts,
    mergedFields: result.mergedFields,
    duplicate: result.duplicate,
  })
}

export async function sharePatient(request, response) {
  const patient = await sharePatientWithWorker(request.params.patientId, request.body, workerId(request))
  response.status(200).json({ success: true, patient })
}

export async function deletePatient(request, response) {
  const patient = await archivePatient(request.params.patientId, request.body, workerId(request))
  response.status(200).json({ success: true, patient, message: 'Patient archived' })
}

export async function postVisit(request, response, dependencies = {}) {
  const create = dependencies.createVisitFn || createVisit
  const enqueue = dependencies.enqueueAssessmentFn || enqueueRiskAssessment
  const result = await create(request.params.patientId, request.body, workerId(request))
  if (result.created) {
    try { enqueue(result.visit._id) } catch { /* Queue failures must not undo a saved visit. */ }
  }
  response.status(result.created ? 201 : 200).json({ success: true, visit: result.visit })
}

export async function patchVisit(request, response) {
  const result = await applyVersionedChanges({
    recordType: 'ASHA_VISIT',
    recordId: request.params.visitId,
    patientId: request.params.patientId,
    changes: request.body?.changes,
    baseValues: request.body?.baseValues,
    baseVersion: request.body?.baseVersion,
    clientOperationId: request.body?.clientOperationId,
    userId: workerId(request),
  })
  if (result.mergedFields.length) enqueueRiskAssessment(result.record._id)
  response.status(200).json({
    success: true,
    visit: result.record,
    conflicts: result.conflicts,
    mergedFields: result.mergedFields,
    duplicate: result.duplicate,
  })
}

export async function getVisits(request, response) {
  const visits = await listPatientVisits(request.params.patientId, workerId(request))
  response.status(200).json({ success: true, visits })
}

export async function getVisit(request, response) {
  const visit = await getPatientVisit(request.params.patientId, request.params.visitId, workerId(request))
  response.status(200).json({ success: true, visit })
}
