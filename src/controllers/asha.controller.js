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
import { getAshaReferralQr } from '../services/referral.service.js'
import { writeSecurityAuditEvent } from '../services/securityAudit.service.js'
import { reportSyncQueue } from '../services/syncReport.service.js'

function workerId(request) {
  return request.user._id.toString()
}

async function runSyncOperation(request, resourceType, operation) {
  try {
    return await operation()
  } catch (error) {
    await writeSecurityAuditEvent({
      actor: request.user._id,
      actorRole: request.user.role,
      action: 'SYNC_FAILED',
      resourceType,
    })
    throw error
  }
}

export async function putSyncReport(request, response) {
  const result = await reportSyncQueue(request.user._id, request.body)
  response.status(200).json({ success: true, ...result })
}

export async function getDashboard(request, response) {
  const summary = await getDashboardSummary(workerId(request))
  response.status(200).json({ success: true, summary })
}

export async function getReferralQr(request, response) {
  const result = await getAshaReferralQr(request.params.referralId, workerId(request))
  response.status(200).json({ success: true, ...result })
}

export async function getPatients(request, response) {
  const result = await listPatients(workerId(request), request.query)
  response.status(200).json({ success: true, ...result })
}

export async function postPatient(request, response) {
  const result = await runSyncOperation(request, 'PATIENT', () => createPatient(request.body, workerId(request)))
  if (result.created) {
    await writeSecurityAuditEvent({ actor: request.user._id, actorRole: request.user.role, action: 'PATIENT_CREATED', resourceType: 'PATIENT', resourceId: result.patient._id })
    await writeSecurityAuditEvent({ actor: request.user._id, actorRole: request.user.role, action: 'SYNC_COMPLETED', resourceType: 'PATIENT', resourceId: result.patient._id })
  }
  response.status(result.created ? 201 : 200).json({ success: true, patient: result.patient })
}

export async function getPatient(request, response) {
  const result = await getPatientProfile(request.params.patientId, workerId(request))
  response.status(200).json({ success: true, ...result })
}

export async function patchPatient(request, response) {
  const result = await runSyncOperation(request, 'PATIENT', () => applyVersionedChanges({
      recordType: 'PATIENT',
      recordId: request.params.patientId,
      changes: request.body?.changes,
      baseValues: request.body?.baseValues,
      baseVersion: request.body?.baseVersion,
      clientOperationId: request.body?.clientOperationId,
      userId: workerId(request),
    }))
  if (result.mergedFields.length) {
    await writeSecurityAuditEvent({ actor: request.user._id, actorRole: request.user.role, action: 'PATIENT_UPDATED', resourceType: 'PATIENT', resourceId: result.record._id })
    await writeSecurityAuditEvent({ actor: request.user._id, actorRole: request.user.role, action: 'SYNC_COMPLETED', resourceType: 'PATIENT', resourceId: result.record._id })
  }
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
  await writeSecurityAuditEvent({ actor: request.user._id, actorRole: request.user.role, action: 'PATIENT_SHARED', resourceType: 'PATIENT', resourceId: patient._id })
  response.status(200).json({ success: true, patient })
}

export async function deletePatient(request, response) {
  const result = await runSyncOperation(request, 'PATIENT', () => archivePatient(request.params.patientId, request.body, workerId(request)))
  const { patient } = result
  if (!result.duplicate) {
    await writeSecurityAuditEvent({ actor: request.user._id, actorRole: request.user.role, action: 'PATIENT_ARCHIVED', resourceType: 'PATIENT', resourceId: patient._id })
    await writeSecurityAuditEvent({ actor: request.user._id, actorRole: request.user.role, action: 'SYNC_COMPLETED', resourceType: 'PATIENT', resourceId: patient._id })
  }
  response.status(200).json({ success: true, patient, message: 'Patient archived' })
}

export async function postVisit(request, response, dependencies = {}) {
  const create = dependencies.createVisitFn || createVisit
  const enqueue = dependencies.enqueueAssessmentFn || enqueueRiskAssessment
  const result = await runSyncOperation(request, 'ASHA_VISIT', () => create(request.params.patientId, request.body, workerId(request)))
  if (result.created) {
    await writeSecurityAuditEvent({ actor: request.user._id, actorRole: request.user.role, action: 'VISIT_CREATED', resourceType: 'ASHA_VISIT', resourceId: result.visit._id })
    await writeSecurityAuditEvent({ actor: request.user._id, actorRole: request.user.role, action: 'SYNC_COMPLETED', resourceType: 'ASHA_VISIT', resourceId: result.visit._id })
    try { enqueue(result.visit._id) } catch { /* Queue failures must not undo a saved visit. */ }
  }
  response.status(result.created ? 201 : 200).json({ success: true, visit: result.visit })
}

export async function patchVisit(request, response) {
  const result = await runSyncOperation(request, 'ASHA_VISIT', () => applyVersionedChanges({
      recordType: 'ASHA_VISIT',
      recordId: request.params.visitId,
      patientId: request.params.patientId,
      changes: request.body?.changes,
      baseValues: request.body?.baseValues,
      baseVersion: request.body?.baseVersion,
      clientOperationId: request.body?.clientOperationId,
      userId: workerId(request),
    }))
  if (result.mergedFields.length) enqueueRiskAssessment(result.record._id)
  if (result.mergedFields.length) {
    await writeSecurityAuditEvent({ actor: request.user._id, actorRole: request.user.role, action: 'VISIT_UPDATED', resourceType: 'ASHA_VISIT', resourceId: result.record._id })
    await writeSecurityAuditEvent({ actor: request.user._id, actorRole: request.user.role, action: 'SYNC_COMPLETED', resourceType: 'ASHA_VISIT', resourceId: result.record._id })
  }
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
