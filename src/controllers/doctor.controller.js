import {
  createDoctorConsultation,
  createDoctorPrescription,
  createDoctorReferral,
  getDoctorCase,
  getDoctorDashboard,
  listDoctorAssessments,
  listDoctorCases,
  takeDoctorCase,
} from '../services/doctor.service.js'

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

export async function takeCase(request, response) {
  const result = await takeDoctorCase(request.params.patientId, doctorId(request))
  response.status(200).json({ success: true, ...result })
}

export async function postConsultation(request, response) {
  const consultation = await createDoctorConsultation(request.params.patientId, doctorId(request), request.body)
  response.status(201).json({ success: true, consultation })
}

export async function postPrescription(request, response) {
  const prescription = await createDoctorPrescription(request.params.patientId, doctorId(request), request.body)
  response.status(201).json({ success: true, prescription })
}

export async function postReferral(request, response) {
  const result = await createDoctorReferral(request.params.patientId, doctorId(request), request.body)
  response.status(201).json({ success: true, ...result })
}
