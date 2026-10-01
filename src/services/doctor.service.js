import mongoose from 'mongoose'
import ASHAVisit from '../models/ASHAVisit.js'
import DoctorConsultation from '../models/DoctorConsultation.js'
import Patient from '../models/Patient.js'
import Prescription from '../models/Prescription.js'
import Referral from '../models/Referral.js'
import ApiError from '../utils/ApiError.js'
import { listNotifications, notifyFollowUpScheduled } from './notification.service.js'
import { markMissedFollowUps } from './followUp.service.js'
import { consumeReferralTokenForDoctor, expireReferralRecords, issueReferral, revokeDoctorReferral } from './referral.service.js'

const CASE_RISK_LEVELS = ['LOW', 'MEDIUM', 'HIGH', 'CRITICAL']
const CONSULTATION_PRIORITIES = ['LOW', 'MEDIUM', 'HIGH', 'CRITICAL']
const CASE_PATIENT_FIELDS = 'fullName gender dateOfBirth phone address status createdAt createdBy ashaWorkers caseStatus assignedDoctor assignedAt'
const VISIT_CASE_FIELDS = 'patient visitDate visitType symptoms medicalHistory allergies currentMedicines vitals observations followUp +aiAssessment'

function isObjectId(value) {
  return mongoose.isValidObjectId(value)
}

function populatedId(value) {
  return value && typeof value === 'object' && value._id ? value._id.toString() : value?.toString?.() || null
}

function ageFromDateOfBirth(value) {
  if (!value) return null
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return null
  const now = new Date()
  let age = now.getFullYear() - date.getFullYear()
  if (now.getMonth() < date.getMonth() || (now.getMonth() === date.getMonth() && now.getDate() < date.getDate())) age -= 1
  return age >= 0 && age <= 125 ? age : null
}

function doctorPatientDto(patient, doctorId = null) {
  const assignedDoctor = patient.assignedDoctor
  return {
    id: patient._id,
    fullName: patient.fullName,
    gender: patient.gender,
    ageYears: ageFromDateOfBirth(patient.dateOfBirth),
    dateOfBirth: patient.dateOfBirth || null,
    phone: patient.phone || '',
    address: patient.address || {},
    caseStatus: patient.caseStatus || (assignedDoctor ? 'ACTIVE' : 'NEW'),
    assignedAt: patient.assignedAt || null,
    assignedDoctor: assignedDoctor ? {
      id: assignedDoctor._id || assignedDoctor,
      name: assignedDoctor.name || '',
      isCurrentUser: doctorId ? populatedId(assignedDoctor) === doctorId.toString() : false,
    } : null,
    createdAt: patient.createdAt,
  }
}

function endOfToday() {
  const end = new Date()
  end.setHours(23, 59, 59, 999)
  return end
}

function fieldQuery(query, fields) {
  return query?.select ? query.select(fields) : query
}

function populateQuery(query, ...args) {
  return query?.populate ? query.populate(...args) : query
}

function sortQuery(query, sort) {
  return query?.sort ? query.sort(sort) : query
}

function leanQuery(query) {
  return query?.lean ? query.lean() : query
}

function textField(value, label, maxLength, { required = false } = {}) {
  if (value === undefined || value === null) value = ''
  if (typeof value !== 'string' || value.trim().length > maxLength || (required && !value.trim())) {
    throw new ApiError(400, `${label} is required and must be at most ${maxLength} characters`)
  }
  return value.trim()
}

function parseFollowUpDate(value) {
  if (value === undefined || value === null || value === '') return null
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) throw new ApiError(400, 'Follow-up date must be valid')
  const today = new Date()
  today.setHours(0, 0, 0, 0)
  if (date < today) throw new ApiError(400, 'Follow-up date cannot be in the past')
  return date
}

async function findDoctorPatient(patientId) {
  if (!isObjectId(patientId)) throw new ApiError(400, 'Patient id is invalid')
  let query = Patient.findOne({ _id: patientId, status: 'ACTIVE' })
  query = fieldQuery(query, `${CASE_PATIENT_FIELDS} +assignedDoctor +caseStatus +assignedAt`)
  query = populateQuery(query, { path: 'assignedDoctor', select: 'name email' })
  return leanQuery(query)
}

function visitAssessment(visit) {
  const assessment = visit?.aiAssessment || {}
  if (assessment.status !== 'AI_ASSESSED') return null
  return {
    status: assessment.status,
    riskLevel: assessment.riskLevel,
    riskScore: assessment.riskScore,
    priority: assessment.priority,
    factors: assessment.factors || [],
    recommendation: assessment.recommendation || '',
    assessedAt: assessment.assessedAt || null,
  }
}

function caseDto(patient, latestVisit, followUpDue, followUpDate, doctorId) {
  const assessment = visitAssessment(latestVisit)
  return {
    patient: doctorPatientDto(patient, doctorId),
    latestVisit: latestVisit ? {
      id: latestVisit._id,
      visitDate: latestVisit.visitDate,
      visitType: latestVisit.visitType,
      symptoms: latestVisit.symptoms,
      vitals: latestVisit.vitals,
      observations: latestVisit.observations,
      aiAssessment: assessment,
    } : null,
    riskLevel: assessment?.riskLevel || null,
    riskScore: assessment?.riskScore ?? null,
    followUpDue,
    followUpDate: followUpDate || null,
  }
}

async function queryPatientVisits(patientIds) {
  if (!patientIds.length) return []
  let query = ASHAVisit.find({ patient: { $in: patientIds } })
  query = fieldQuery(query, VISIT_CASE_FIELDS)
  query = sortQuery(query, { visitDate: -1 })
  return leanQuery(query)
}

export async function listDoctorCases(doctorId, filters = {}) {
  if (filters.riskLevel && !CASE_RISK_LEVELS.includes(filters.riskLevel)) throw new ApiError(400, 'Risk level filter is invalid')
  if (filters.assigned && !['UNASSIGNED', 'MINE'].includes(filters.assigned)) throw new ApiError(400, 'Assignment filter is invalid')
  const patientFilter = { status: 'ACTIVE', caseStatus: { $ne: 'CLOSED' } }
  const search = typeof filters.q === 'string' ? filters.q.trim().slice(0, 80) : ''
  if (filters.assigned === 'UNASSIGNED') patientFilter.assignedDoctor = null
  if (filters.assigned === 'MINE') patientFilter.assignedDoctor = doctorId
  if (search) {
    const escaped = search.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    patientFilter.fullName = { $regex: escaped, $options: 'i' }
  }

  let patientQuery = Patient.find(patientFilter)
  patientQuery = fieldQuery(patientQuery, `${CASE_PATIENT_FIELDS} +assignedDoctor +caseStatus +assignedAt`)
  patientQuery = populateQuery(patientQuery, { path: 'assignedDoctor', select: 'name email' })
  patientQuery = sortQuery(patientQuery, { createdAt: -1 })
  let patients = await leanQuery(patientQuery)
  await markMissedFollowUps(patients.map((patient) => patient._id))
  const visits = await queryPatientVisits(patients.map((patient) => patient._id))
  const latestVisits = new Map()
  const visitFollowUps = new Map()
  for (const visit of visits) {
    const patientKey = populatedId(visit.patient)
    if (!latestVisits.has(patientKey)) latestVisits.set(patientKey, visit)
    if (visit.followUp?.status === 'SCHEDULED' && visit.followUp.date && visit.followUp.date <= endOfToday()) {
      const previous = visitFollowUps.get(patientKey)
      if (!previous || visit.followUp.date < previous) visitFollowUps.set(patientKey, visit.followUp.date)
    }
  }

  const dueConsultations = patients.length
    ? await leanQuery(fieldQuery(DoctorConsultation.find({
      patient: { $in: patients.map((patient) => patient._id) },
      followUpDate: { $ne: null, $lte: endOfToday() },
      followUpStatus: { $in: ['PENDING', 'MISSED', null] },
    }), 'patient followUpDate'))
    : []
  const consultationFollowUps = new Map()
  for (const consultation of dueConsultations) {
    const patientKey = populatedId(consultation.patient)
    if (!consultationFollowUps.has(patientKey) || consultation.followUpDate < consultationFollowUps.get(patientKey)) {
      consultationFollowUps.set(patientKey, consultation.followUpDate)
    }
  }

  const results = patients.map((patient) => {
    const patientKey = patient._id.toString()
    const dueDates = [visitFollowUps.get(patientKey), consultationFollowUps.get(patientKey)].filter(Boolean)
    const followUpDate = dueDates.sort((left, right) => left - right)[0] || null
    const due = Boolean(followUpDate)
    return caseDto(patient, latestVisits.get(patientKey) || null, due, followUpDate, doctorId)
  }).filter((item) => (
    (!filters.riskLevel || item.riskLevel === filters.riskLevel)
    && (!(filters.followUpDue === true || filters.followUpDue === 'true') || item.followUpDue)
  ))
  return results
}

export async function getDoctorDashboard(doctorId) {
  const cases = await listDoctorCases(doctorId)
  const recentCutoff = Date.now() - 7 * 24 * 60 * 60 * 1000
  const doctorIdString = doctorId.toString()
  const notifications = await listNotifications(doctorId)
  return {
    summary: {
      newCases: cases.filter(({ patient }) => patient.caseStatus === 'NEW' && new Date(patient.createdAt).getTime() >= recentCutoff).length,
      unassignedCases: cases.filter(({ patient }) => !patient.assignedDoctor).length,
      myActiveCases: cases.filter(({ patient }) => patient.caseStatus === 'ACTIVE' && populatedId(patient.assignedDoctor?.id) === doctorIdString).length,
      highRiskCases: cases.filter((item) => item.riskLevel === 'HIGH').length,
      criticalCases: cases.filter((item) => item.riskLevel === 'CRITICAL').length,
      followUps: cases.filter((item) => item.followUpDue).length,
      notifications,
    },
    cases,
    notifications,
  }
}

export async function getDoctorCase(patientId, doctorId) {
  const patient = await findDoctorPatient(patientId)
  if (!patient) throw new ApiError(404, 'Patient case not found')
  const patientObjectId = patient._id
  await markMissedFollowUps([patientObjectId])
  let visitsQuery = ASHAVisit.find({ patient: patientObjectId })
  visitsQuery = fieldQuery(visitsQuery, VISIT_CASE_FIELDS)
  visitsQuery = sortQuery(visitsQuery, { visitDate: -1 })
  const [visits, consultations, prescriptions, referrals] = await Promise.all([
    leanQuery(visitsQuery),
    leanQuery(sortQuery(populateQuery(DoctorConsultation.find({ patient: patientObjectId }), { path: 'doctor', select: 'name' }), { createdAt: -1 })),
    leanQuery(sortQuery(populateQuery(Prescription.find({ patient: patientObjectId }), { path: 'doctor', select: 'name' }), { createdAt: -1 })),
    leanQuery(sortQuery(populateQuery(Referral.find({ patient: patientObjectId }), { path: 'doctor', select: 'name' }), { createdAt: -1 })),
  ])
  await expireReferralRecords(referrals)
  const mostRecentWith = (field) => visits.find((visit) => Array.isArray(visit[field]) && visit[field].length)?.[field] || []
  const timeline = [
    ...visits.map((visit) => ({ id: visit._id, type: 'ASHA_VISIT', date: visit.visitDate, title: visit.visitType === 'FOLLOW_UP' ? 'ASHA follow-up visit' : 'ASHA visit', summary: visit.symptoms?.chiefComplaint || 'Visit recorded' })),
    ...consultations.flatMap((consultation) => [
      { id: consultation._id, type: 'CONSULTATION', date: consultation.createdAt, title: 'Doctor consultation', summary: consultation.assessment || consultation.notes, doctor: consultation.doctor?.name || '' },
      ...(consultation.followUpDate ? [{ id: `follow-up-${consultation._id}`, type: 'FOLLOW_UP_SCHEDULED', date: consultation.followUpDate, title: 'Follow-up scheduled', summary: `Status: ${consultation.followUpStatus || 'PENDING'}`, status: consultation.followUpStatus || 'PENDING' }] : []),
    ]),
    ...prescriptions.map((prescription) => ({ id: prescription._id, type: 'PRESCRIPTION', date: prescription.createdAt, title: 'Prescription added', summary: prescription.items?.map((item) => item.medicine).join(', ') || 'Prescription' })),
    ...referrals.map((referral) => ({ id: referral._id, type: 'REFERRAL', date: referral.createdAt, title: 'Patient referred', summary: `${referral.priority} · ${referral.reason}`, status: referral.status })),
  ].sort((left, right) => new Date(right.date) - new Date(left.date))

  return {
    patient: doctorPatientDto(patient, doctorId),
    medicalHistory: mostRecentWith('medicalHistory'),
    allergies: mostRecentWith('allergies'),
    currentMedicines: mostRecentWith('currentMedicines'),
    visits,
    consultations,
    prescriptions,
    referrals,
    timeline,
  }
}

export async function getDoctorCaseByReferralToken(token, doctorId) {
  const patientId = await consumeReferralTokenForDoctor(token, doctorId)
  return getDoctorCase(patientId, doctorId)
}

async function requireAssignedDoctor(patientId, doctorId) {
  const patient = await findDoctorPatient(patientId)
  if (!patient) throw new ApiError(404, 'Patient case not found')
  if (populatedId(patient.assignedDoctor) !== doctorId.toString()) {
    throw new ApiError(409, 'Take this case before performing doctor actions', 'CASE_NOT_ASSIGNED_TO_DOCTOR')
  }
  return patient
}

export async function takeDoctorCase(patientId, doctorId) {
  if (!isObjectId(patientId) || !isObjectId(doctorId)) throw new ApiError(400, 'Patient or doctor id is invalid')
  let query = Patient.findOneAndUpdate(
    { _id: patientId, status: 'ACTIVE', caseStatus: { $ne: 'CLOSED' }, assignedDoctor: null },
    { $set: { assignedDoctor: doctorId, assignedAt: new Date(), caseStatus: 'ACTIVE' } },
    { returnDocument: 'after', runValidators: true },
  )
  query = fieldQuery(query, '+assignedDoctor +assignedAt +caseStatus')
  const assigned = await query
  if (assigned) return { patient: doctorPatientDto(assigned.toObject ? assigned.toObject() : assigned, doctorId), alreadyAssigned: false }
  const current = await findDoctorPatient(patientId)
  if (!current) throw new ApiError(404, 'Patient case not found')
  if (populatedId(current.assignedDoctor) === doctorId.toString()) {
    return { patient: doctorPatientDto(current, doctorId), alreadyAssigned: true }
  }
  throw new ApiError(409, 'This case has already been taken by another doctor', 'CASE_ALREADY_ASSIGNED')
}

export async function createDoctorConsultation(patientId, doctorId, input = {}) {
  const patient = await requireAssignedDoctor(patientId, doctorId)
  const notes = textField(input.notes, 'Clinical notes', 10000, { required: true })
  const assessment = textField(input.assessment, 'Assessment', 5000)
  const treatmentPlan = textField(input.treatmentPlan, 'Treatment plan', 5000)
  const priority = input.priority || 'LOW'
  if (!CONSULTATION_PRIORITIES.includes(priority)) throw new ApiError(400, 'Consultation priority is invalid')
  const followUpDate = parseFollowUpDate(input.followUpDate)
  let ashaVisit = null
  if (input.ashaVisitId) {
    if (!isObjectId(input.ashaVisitId)) throw new ApiError(400, 'ASHA visit id is invalid')
    ashaVisit = await ASHAVisit.findOne({ _id: input.ashaVisitId, patient: patient._id }).select('_id')
    if (!ashaVisit) throw new ApiError(404, 'ASHA visit not found for this patient')
    ashaVisit = ashaVisit._id
  }
  const consultation = await DoctorConsultation.create({
    patient: patient._id,
    doctor: doctorId,
    ashaVisit,
    notes,
    assessment,
    treatmentPlan,
    priority,
    followUpDate,
    followUpStatus: followUpDate ? 'PENDING' : null,
  })
  if (followUpDate) await notifyFollowUpScheduled(consultation, patient)
  return consultation
}

export async function createDoctorPrescription(patientId, doctorId, input = {}) {
  const patient = await requireAssignedDoctor(patientId, doctorId)
  if (!isObjectId(input.consultationId)) throw new ApiError(400, 'A valid consultation id is required')
  const consultation = await DoctorConsultation.findOne({ _id: input.consultationId, patient: patient._id, doctor: doctorId }).select('_id')
  if (!consultation) throw new ApiError(404, 'Consultation not found for this doctor and patient')
  if (!Array.isArray(input.items) || input.items.length < 1 || input.items.length > 20) throw new ApiError(400, 'A prescription must include 1 to 20 medicines')
  const items = input.items.map((item, index) => ({
    medicine: textField(item?.medicine, `Medicine ${index + 1}`, 200, { required: true }),
    dosage: textField(item?.dosage, `Dosage ${index + 1}`, 120, { required: true }),
    frequency: textField(item?.frequency, `Frequency ${index + 1}`, 120, { required: true }),
    duration: textField(item?.duration, `Duration ${index + 1}`, 120),
    instructions: textField(item?.instructions, `Instructions ${index + 1}`, 500),
  }))
  const notes = textField(input.notes, 'Prescription notes', 2000)
  return Prescription.create({ patient: patient._id, consultation: consultation._id, doctor: doctorId, items, notes })
}

export async function createDoctorReferral(patientId, doctorId, input = {}) {
  const patient = await requireAssignedDoctor(patientId, doctorId)
  if (!isObjectId(input.consultationId)) throw new ApiError(400, 'A valid consultation id is required')
  const consultation = await DoctorConsultation.findOne({ _id: input.consultationId, patient: patient._id, doctor: doctorId }).select('_id priority')
  if (!consultation) throw new ApiError(404, 'Consultation not found for this doctor and patient')
  const reason = textField(input.reason, 'Referral reason', 2000, { required: true })
  const priority = input.priority || (consultation.priority === 'CRITICAL' ? 'CRITICAL' : 'HIGH')
  if (!['HIGH', 'CRITICAL'].includes(priority)) throw new ApiError(400, 'Referral priority must be HIGH or CRITICAL')
  const destinationInput = input.destination ?? {}
  if (!destinationInput || typeof destinationInput !== 'object' || Array.isArray(destinationInput)) {
    throw new ApiError(400, 'Referral destination must be an object')
  }
  const destination = {
    facilityName: textField(destinationInput.facilityName, 'Destination name', 160),
    address: textField(destinationInput.address, 'Destination address', 300),
  }
  return issueReferral({ patient, consultation, doctorId, reason, priority, destination })
}

export async function revokeDoctorPatientReferral(patientId, referralId, doctorId) {
  const patient = await requireAssignedDoctor(patientId, doctorId)
  return revokeDoctorReferral({ patientId: patient._id, referralId, doctorId })
}

export function doctorAssessmentDto(visit) {
  const assessment = visit.aiAssessment || {}
  const patient = visit.patient || {}
  return {
    visitId: visit._id,
    visitDate: visit.visitDate,
    patient: {
      fullName: patient.fullName || 'Patient',
      gender: patient.gender || 'UNKNOWN',
      ageYears: ageFromDateOfBirth(patient.dateOfBirth),
    },
    symptoms: visit.symptoms,
    vitals: visit.vitals,
    observations: visit.observations,
    assessment: {
      status: assessment.status || 'AI_ASSESSMENT_PENDING',
      riskLevel: assessment.riskLevel || null,
      riskScore: assessment.riskScore ?? null,
      priority: assessment.priority || null,
      factors: assessment.factors || [],
      recommendation: assessment.recommendation || '',
      assessedAt: assessment.assessedAt || null,
    },
  }
}

export async function listDoctorAssessments() {
  const visits = await ASHAVisit.find({})
    .select('patient visitDate symptoms vitals observations +aiAssessment')
    .populate({ path: 'patient', select: 'fullName gender dateOfBirth status', match: { status: 'ACTIVE' } })
    .sort({ visitDate: -1 })
    .limit(100)
    .lean()
  return visits.filter((visit) => visit.patient).map(doctorAssessmentDto)
}
