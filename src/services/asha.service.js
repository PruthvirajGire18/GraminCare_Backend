import { randomUUID } from 'node:crypto'
import mongoose from 'mongoose'
import ASHAVisit from '../models/ASHAVisit.js'
import DoctorConsultation from '../models/DoctorConsultation.js'
import Patient from '../models/Patient.js'
import Referral from '../models/Referral.js'
import User from '../models/User.js'
import ApiError from '../utils/ApiError.js'
import { listNotifications, notifyFollowUpCompleted } from './notification.service.js'
import { markMissedFollowUps } from './followUp.service.js'

const PATIENT_GENDERS = ['FEMALE', 'MALE', 'OTHER', 'UNKNOWN']
const VISIT_TYPES = ['INITIAL', 'FOLLOW_UP']
const VITAL_RANGES = {
  temperatureC: [25, 45],
  heartRateBpm: [20, 250],
  respiratoryRatePerMinute: [4, 80],
  systolicMmHg: [40, 300],
  diastolicMmHg: [20, 200],
  oxygenSaturationPercent: [50, 100],
  weightKg: [0.3, 500],
  heightCm: [20, 250],
}
const ADDRESS_FIELDS = ['village', 'district', 'state', 'details']

export function validateClientOperationId(value) {
  if (typeof value !== 'string' || value.length < 16 || value.length > 128 || !/^[A-Za-z0-9_-]+$/.test(value)) {
    throw new ApiError(400, 'A valid clientOperationId is required for offline-safe operations')
  }
  return value
}

function requireText(value, label, minLength, maxLength) {
  if (typeof value !== 'string' || value.trim().length < minLength || value.trim().length > maxLength) {
    throw new ApiError(400, `${label} must be between ${minLength} and ${maxLength} characters`)
  }
  return value.trim()
}

function optionalText(value, label, maxLength) {
  if (value === undefined || value === null || value === '') return ''
  if (typeof value !== 'string' || value.trim().length > maxLength) {
    throw new ApiError(400, `${label} must be at most ${maxLength} characters`)
  }
  return value.trim()
}

function parseDate(value, label, { allowFuture = true } = {}) {
  if (value === undefined || value === null || value === '') return null
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) throw new ApiError(400, `${label} must be a valid date`)
  if (!allowFuture && date > new Date()) throw new ApiError(400, `${label} cannot be in the future`)
  return date
}

function normalizeAddress(address = {}) {
  if (!address || typeof address !== 'object' || Array.isArray(address)) {
    throw new ApiError(400, 'Address must be an object')
  }
  return {
    village: optionalText(address.village, 'Village', 120),
    district: optionalText(address.district, 'District', 120),
    state: optionalText(address.state, 'State', 120),
    details: optionalText(address.details, 'Address details', 300),
  }
}

export function validatePatientPayload(input, { partial = false } = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new ApiError(400, 'Patient details are required')
  }
  const result = {}

  if (!partial || Object.hasOwn(input, 'fullName')) {
    result.fullName = requireText(input.fullName, 'Full name', 2, 120)
  }
  if (!partial || Object.hasOwn(input, 'gender')) {
    if (!PATIENT_GENDERS.includes(input.gender)) throw new ApiError(400, 'Gender is invalid')
    result.gender = input.gender
  }
  if (!partial || Object.hasOwn(input, 'dateOfBirth')) {
    result.dateOfBirth = parseDate(input.dateOfBirth, 'Date of birth', { allowFuture: false })
  }
  if (!partial || Object.hasOwn(input, 'phone')) {
    result.phone = optionalText(input.phone, 'Phone number', 25)
    if (result.phone && !/^\+?[0-9().\s-]{5,25}$/.test(result.phone)) throw new ApiError(400, 'Phone number contains invalid characters')
  }
  if (!partial || Object.hasOwn(input, 'address')) result.address = normalizeAddress(input.address)
  if (partial && Object.keys(result).length === 0) throw new ApiError(400, 'Provide at least one patient field to update')
  return result
}

function normalizeStringList(values, label, maxItems, maxLength) {
  if (values === undefined || values === null) return []
  if (!Array.isArray(values) || values.length > maxItems) throw new ApiError(400, `${label} must be a list of at most ${maxItems} items`)
  return values.map((value, index) => requireText(value, `${label} item ${index + 1}`, 1, maxLength))
}

export function validateVisitPayload(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new ApiError(400, 'Visit details are required')
  const visitType = input.visitType || 'INITIAL'
  if (!VISIT_TYPES.includes(visitType)) throw new ApiError(400, 'Visit type must be INITIAL or FOLLOW_UP')
  const symptoms = {
    chiefComplaint: requireText(input.symptoms?.chiefComplaint, 'Chief complaint', 2, 1000),
    details: optionalText(input.symptoms?.details, 'Symptom details', 4000),
  }
  if (input.symptoms?.durationDays !== undefined && input.symptoms.durationDays !== null && input.symptoms.durationDays !== '') {
    const durationDays = Number(input.symptoms.durationDays)
    if (!Number.isInteger(durationDays) || durationDays < 0 || durationDays > 365) {
      throw new ApiError(400, 'Symptom duration must be a whole number from 0 to 365 days')
    }
    symptoms.durationDays = durationDays
  } else {
    symptoms.durationDays = null
  }
  const visitDate = parseDate(input.visitDate, 'Visit date', { allowFuture: false }) || new Date()
  const followUpDate = parseDate(input.followUp?.date ?? input.followUpDate, 'Follow-up date')
  const vitalsInput = input.vitals || {}
  if (typeof vitalsInput !== 'object' || Array.isArray(vitalsInput)) throw new ApiError(400, 'Vitals must be an object')
  const vitals = {}
  for (const [field, [minimum, maximum]] of Object.entries(VITAL_RANGES)) {
    const value = vitalsInput[field]
    if (value === undefined || value === null || value === '') {
      vitals[field] = null
      continue
    }
    const numericValue = Number(value)
    if (!Number.isFinite(numericValue) || numericValue < minimum || numericValue > maximum) {
      throw new ApiError(400, `${field} must be between ${minimum} and ${maximum}`)
    }
    vitals[field] = numericValue
  }
  if (vitals.systolicMmHg !== null && vitals.diastolicMmHg !== null && vitals.diastolicMmHg >= vitals.systolicMmHg) {
    throw new ApiError(400, 'Diastolic blood pressure must be lower than systolic blood pressure')
  }
  const followUpOf = input.followUpOf || null
  const followUpConsultationId = input.followUpConsultationId || null
  if (followUpOf && followUpConsultationId) throw new ApiError(400, 'A follow-up must complete one scheduled item')
  if (visitType === 'FOLLOW_UP' && !mongoose.isValidObjectId(followUpOf) && !mongoose.isValidObjectId(followUpConsultationId)) {
    throw new ApiError(400, 'A follow-up visit must reference the scheduled item it completes')
  }
  if (visitType === 'INITIAL' && (followUpOf || followUpConsultationId)) throw new ApiError(400, 'Initial visits cannot reference a prior follow-up')

  return {
    visitType,
    visitDate,
    followUpOf,
    followUpConsultation: followUpConsultationId,
    symptoms,
    medicalHistory: normalizeStringList(input.medicalHistory, 'Medical history', 30, 300),
    allergies: normalizeStringList(input.allergies, 'Allergies', 30, 200),
    currentMedicines: normalizeStringList(input.currentMedicines, 'Current medicines', 30, 200),
    vitals,
    observations: optionalText(input.observations, 'Observations', 4000),
    followUp: { date: followUpDate, status: followUpDate ? 'SCHEDULED' : 'NOT_SCHEDULED', completedByVisit: null },
  }
}

function validateObjectId(id, label) {
  if (!mongoose.isValidObjectId(id)) throw new ApiError(400, `${label} is invalid`)
}

export async function findOwnedPatient(patientId, ashaWorkerId, { includeArchived = false } = {}) {
  validateObjectId(patientId, 'Patient id')
  const filter = { _id: patientId, $or: [{ createdBy: ashaWorkerId }, { ashaWorkers: ashaWorkerId }] }
  if (!includeArchived) filter.status = 'ACTIVE'
  const patient = await Patient.findOne(filter)
  if (!patient) throw new ApiError(404, 'Patient not found')
  return patient
}

export async function createPatient(input, ashaWorkerId) {
  const patientData = validatePatientPayload(input)
  const clientOperationId = validateClientOperationId(input.clientOperationId)
  const filter = { createdBy: ashaWorkerId, clientOperationId }
  const existing = await Patient.findOne(filter)
  if (existing) return { patient: existing, created: false }

  try {
    const patient = await Patient.create({
      ...patientData,
      createdBy: ashaWorkerId,
      ashaWorkers: [ashaWorkerId],
      version: 1,
      updatedBy: ashaWorkerId,
      clientOperationId,
    })
    return { patient, created: true }
  } catch (error) {
    if (error.code !== 11000) throw error
    const duplicate = await Patient.findOne(filter)
    if (duplicate) return { patient: duplicate, created: false }
    throw error
  }
}

export async function listPatients(ashaWorkerId, { q = '', page = 1, limit = 20 } = {}) {
  const pageNumber = Math.max(1, Number.parseInt(page, 10) || 1)
  const pageSize = Math.min(50, Math.max(1, Number.parseInt(limit, 10) || 20))
  const filter = { $or: [{ createdBy: ashaWorkerId }, { ashaWorkers: ashaWorkerId }], status: 'ACTIVE' }
  const query = typeof q === 'string' ? q.trim().slice(0, 80) : ''
  if (query) {
    const escapedQuery = query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    filter.$and = [{ $or: [
      { fullName: { $regex: escapedQuery, $options: 'i' } },
      { phone: { $regex: escapedQuery, $options: 'i' } },
    ] }]
  }
  const [patients, total] = await Promise.all([
    Patient.find(filter).sort({ fullName: 1 }).skip((pageNumber - 1) * pageSize).limit(pageSize).lean(),
    Patient.countDocuments(filter),
  ])
  return { patients, total, page: pageNumber, limit: pageSize }
}

export async function getPatientProfile(patientId, ashaWorkerId) {
  const patient = await findOwnedPatient(patientId, ashaWorkerId)
  await markMissedFollowUps([patient._id])
  const [visits, consultations] = await Promise.all([
    ASHAVisit.find({ patient: patient._id }).sort({ visitDate: -1 }).lean(),
    DoctorConsultation.find({ patient: patient._id, followUpStatus: { $in: ['PENDING', 'MISSED'] }, followUpDate: { $ne: null } })
      .populate({ path: 'doctor', select: 'name' })
      .sort({ followUpDate: 1 })
      .lean(),
  ])
  const doctorFollowUps = consultations.map((consultation) => ({
    consultationId: consultation._id,
    patientId: patient._id,
    patientName: patient.fullName,
    doctorName: consultation.doctor?.name || 'Doctor',
    dueDate: consultation.followUpDate,
    status: consultation.followUpStatus,
  }))
  return { patient, visits, doctorFollowUps }
}

export async function updatePatient(patientId, input, ashaWorkerId) {
  const patient = await findOwnedPatient(patientId, ashaWorkerId)
  const changes = validatePatientPayload(input.changes || input, { partial: true })
  if (input.baseVersion !== patient.version) throw new ApiError(409, 'Patient version changed; reload before updating')
  Object.assign(patient, changes)
  patient.version += 1
  patient.updatedBy = ashaWorkerId
  patient.clientOperationId = validateClientOperationId(input.clientOperationId)
  await patient.save()
  return patient
}

export async function archivePatient(patientId, input, ashaWorkerId) {
  const patient = await findOwnedPatient(patientId, ashaWorkerId)
  if (!Number.isInteger(input?.baseVersion) || input.baseVersion !== patient.version) {
    throw new ApiError(409, 'Patient version changed; reload before archiving')
  }
  patient.status = 'ARCHIVED'
  patient.version += 1
  patient.updatedBy = ashaWorkerId
  patient.clientOperationId = validateClientOperationId(input.clientOperationId)
  await patient.save()
  return patient
}

export async function sharePatientWithWorker(patientId, input, ashaWorkerId) {
  const patient = await findOwnedPatient(patientId, ashaWorkerId)
  if (patient.createdBy.toString() !== ashaWorkerId) throw new ApiError(403, 'Only the patient record owner can share it')
  if (!Number.isInteger(input?.baseVersion) || input.baseVersion !== patient.version) throw new ApiError(409, 'Patient changed before sharing; reload the profile')
  const clientOperationId = validateClientOperationId(input.clientOperationId)
  const email = typeof input.email === 'string' ? input.email.trim().toLowerCase() : ''
  const worker = await User.findOne({ email, role: 'ASHA_WORKER', status: 'APPROVED' })
  if (!worker) throw new ApiError(404, 'Approved ASHA worker not found')
  if (patient.ashaWorkers.some((workerId) => workerId.toString() === worker._id.toString())) return patient
  patient.ashaWorkers.push(worker._id)
  patient.version += 1
  patient.updatedBy = ashaWorkerId
  patient.clientOperationId = clientOperationId
  await patient.save()
  return patient
}

export async function createVisit(patientId, input, ashaWorkerId) {
  const patient = await findOwnedPatient(patientId, ashaWorkerId)
  const clientOperationId = validateClientOperationId(input?.clientOperationId)
  const idempotencyFilter = { patient: patient._id, ashaWorker: ashaWorkerId, clientOperationId }
  const existing = await ASHAVisit.findOne(idempotencyFilter)
  if (existing) return { visit: existing, created: false }
  const visitData = validateVisitPayload(input)
  let previousVisit = null
  let consultation = null
  if (visitData.visitType === 'FOLLOW_UP') {
    if (visitData.followUpOf) {
      previousVisit = await ASHAVisit.findOne({ _id: visitData.followUpOf, patient: patient._id, 'followUp.status': 'SCHEDULED' })
      if (!previousVisit) throw new ApiError(409, 'The scheduled follow-up was not found or was already completed')
    } else {
      consultation = await DoctorConsultation.findOne({
        _id: visitData.followUpConsultation,
        patient: patient._id,
        followUpDate: { $ne: null },
        followUpStatus: { $in: ['PENDING', 'MISSED'] },
        followUpVisit: null,
      })
      if (!consultation) throw new ApiError(409, 'The doctor follow-up was not found or was already completed')
    }
  }
  let visit
  try {
    visit = await ASHAVisit.create({
      ...visitData,
      patient: patient._id,
      ashaWorker: ashaWorkerId,
      version: 1,
      updatedBy: ashaWorkerId,
      clientOperationId,
    })
  } catch (error) {
    if (error.code !== 11000) throw error
    const duplicate = await ASHAVisit.findOne(idempotencyFilter)
    if (duplicate) return { visit: duplicate, created: false }
    if (consultation) throw new ApiError(409, 'This doctor follow-up has already been completed')
    throw error
  }
  if (consultation) {
    try {
      const completion = await DoctorConsultation.updateOne(
        { _id: consultation._id, patient: patient._id, followUpStatus: { $in: ['PENDING', 'MISSED'] }, followUpVisit: null },
        { $set: { followUpStatus: 'COMPLETED', followUpVisit: visit._id } },
      )
      const matched = completion.matchedCount ?? completion.n ?? 1
      if (!matched) throw new ApiError(409, 'This doctor follow-up has already been completed')
    } catch (error) {
      try { await ASHAVisit.deleteOne({ _id: visit._id }) } catch { /* Preserve the completion error for the caller. */ }
      throw error
    }
    await notifyFollowUpCompleted(consultation, patient, visit)
  }
  if (previousVisit) {
    previousVisit.followUp.status = 'COMPLETED'
    previousVisit.followUp.completedByVisit = visit._id
    previousVisit.version += 1
    previousVisit.updatedBy = ashaWorkerId
    previousVisit.clientOperationId = `followup_${randomUUID()}`
    await previousVisit.save()
  }
  return { visit, created: true }
}

export async function listPatientVisits(patientId, ashaWorkerId) {
  const patient = await findOwnedPatient(patientId, ashaWorkerId)
  return ASHAVisit.find({ patient: patient._id }).sort({ visitDate: -1 }).lean()
}

export async function getPatientVisit(patientId, visitId, ashaWorkerId) {
  const patient = await findOwnedPatient(patientId, ashaWorkerId)
  validateObjectId(visitId, 'Visit id')
  const visit = await ASHAVisit.findOne({ _id: visitId, patient: patient._id }).lean()
  if (!visit) throw new ApiError(404, 'Visit not found')
  return visit
}

export async function getDashboardSummary(ashaWorkerId) {
  const startOfToday = new Date()
  startOfToday.setHours(0, 0, 0, 0)
  const startOfTomorrow = new Date(startOfToday)
  startOfTomorrow.setDate(startOfTomorrow.getDate() + 1)
  const now = new Date()
  const patients = await Patient.find({ $or: [{ createdBy: ashaWorkerId }, { ashaWorkers: ashaWorkerId }], status: 'ACTIVE' }).select('_id').lean()
  const patientIds = patients.map((patient) => patient._id)
  await markMissedFollowUps(patientIds)
  const [todaysVisits, scheduledVisitFollowUps, consultations, referrals, notifications] = await Promise.all([
    ASHAVisit.countDocuments({ patient: { $in: patientIds }, visitDate: { $gte: startOfToday, $lt: startOfTomorrow } }),
    ASHAVisit.find({ patient: { $in: patientIds }, 'followUp.status': 'SCHEDULED', 'followUp.date': { $ne: null, $lte: startOfTomorrow } }).select('patient followUp').populate({ path: 'patient', select: 'fullName' }).lean(),
    DoctorConsultation.find({ patient: { $in: patientIds }, followUpStatus: { $in: ['PENDING', 'MISSED'] }, followUpDate: { $ne: null } })
      .populate({ path: 'patient', select: 'fullName' })
      .populate({ path: 'doctor', select: 'name' })
      .sort({ followUpDate: 1 })
      .limit(100)
      .lean(),
    Referral.countDocuments({ ashaWorker: ashaWorkerId, status: 'ACTIVE', expiresAt: { $gt: now } }),
    listNotifications(ashaWorkerId, 20),
  ])
  const doctorFollowUps = consultations.filter((consultation) => consultation.patient).map((consultation) => ({
    consultationId: consultation._id,
    patientId: consultation.patient._id,
    patientName: consultation.patient.fullName,
    doctorName: consultation.doctor?.name || 'Doctor',
    dueDate: consultation.followUpDate,
    status: consultation.followUpStatus,
  }))
  const doctorDueCount = doctorFollowUps.filter((item) => item.status === 'MISSED' || item.dueDate <= startOfTomorrow).length
  const followUps = scheduledVisitFollowUps.length + doctorDueCount
  const followUpVisits = scheduledVisitFollowUps.map((visit) => ({
    patientId: visit.patient?._id,
    patientName: visit.patient?.fullName || 'Patient',
    dueDate: visit.followUp?.date,
    status: 'PENDING',
    source: 'ASHA_VISIT',
  }))
  return {
    totalPatients: patientIds.length,
    todaysVisits,
    pendingSync: 0,
    syncEnabled: false,
    followUps,
    doctorFollowUps,
    followUpVisits,
    notifications,
    referrals,
  }
}
