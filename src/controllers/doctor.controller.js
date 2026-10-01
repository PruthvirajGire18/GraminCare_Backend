import {
  createDoctorConsultation,
  createDoctorPrescription,
  createDoctorReferral,
  getDoctorCase,
  getDoctorCaseByReferralToken,
  getDoctorDashboard,
  listDoctorAssessments,
  listDoctorCases,
  revokeDoctorPatientReferral,
  takeDoctorCase,
} from '../services/doctor.service.js'
import { writeSecurityAuditEvent } from '../services/securityAudit.service.js'

function doctorId(request) {
  return request.user._id.toString()
}

export async function getAssessments(_request, response) {
  const assessments = await listDoctorAssessments()
  response.status(200).json({ success: true, assessments })
}

export async function getDashboard(request, response) {
  const result = await getDoctorDashboard(doctorId(request))
  response.status(200).json({ success: true, ...result })
}

export async function getCases(request, response) {
  const cases = await listDoctorCases(doctorId(request), request.query)
  response.status(200).json({ success: true, cases })
}

export async function getCase(request, response) {
  const patientCase = await getDoctorCase(request.params.patientId, doctorId(request))
  response.status(200).json({ success: true, ...patientCase })
}

export async function getCaseByReferralQr(request, response) {
  const patientCase = await getDoctorCaseByReferralToken(request.body?.token, doctorId(request))
  await writeSecurityAuditEvent({
    actor: request.user._id,
    actorRole: request.user.role,
    action: 'PATIENT_RECORD_ACCESSED_BY_QR',
    resourceType: 'PATIENT',
    resourceId: patientCase.patient.id,
  })
  response.status(200).json({ success: true, ...patientCase })
}

export async function takeCase(request, response) {
  const result = await takeDoctorCase(request.params.patientId, doctorId(request))
  if (!result.alreadyAssigned) {
    await writeSecurityAuditEvent({ actor: request.user._id, actorRole: request.user.role, action: 'CASE_ASSIGNED', resourceType: 'CASE', resourceId: request.params.patientId })
  }
  response.status(200).json({ success: true, ...result })
}

export async function postConsultation(request, response) {
  const consultation = await createDoctorConsultation(request.params.patientId, doctorId(request), request.body)
  await writeSecurityAuditEvent({ actor: request.user._id, actorRole: request.user.role, action: 'CONSULTATION_CREATED', resourceType: 'CONSULTATION', resourceId: consultation._id })
  response.status(201).json({ success: true, consultation })
}

export async function postPrescription(request, response) {
  const prescription = await createDoctorPrescription(request.params.patientId, doctorId(request), request.body)
  await writeSecurityAuditEvent({ actor: request.user._id, actorRole: request.user.role, action: 'PRESCRIPTION_CREATED', resourceType: 'PRESCRIPTION', resourceId: prescription._id })
  response.status(201).json({ success: true, prescription })
}

export async function postReferral(request, response) {
  const result = await createDoctorReferral(request.params.patientId, doctorId(request), request.body)
  response.status(201).json({ success: true, ...result })
}

export async function revokeReferral(request, response) {
  const result = await revokeDoctorPatientReferral(request.params.patientId, request.params.referralId, doctorId(request))
  response.status(200).json({ success: true, referral: result })
}
