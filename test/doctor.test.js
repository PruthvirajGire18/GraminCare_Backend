import assert from 'node:assert/strict'
import test from 'node:test'
import ASHAVisit from '../src/models/ASHAVisit.js'
import DoctorConsultation from '../src/models/DoctorConsultation.js'
import Patient from '../src/models/Patient.js'
import Prescription from '../src/models/Prescription.js'
import Referral from '../src/models/Referral.js'
import Notification from '../src/models/Notification.js'
import doctorRouter from '../src/routes/doctor.routes.js'
import { requireAuth } from '../src/middleware/auth.middleware.js'
import { requireRole } from '../src/middleware/role.middleware.js'
import {
  createDoctorConsultation,
  createDoctorPrescription,
  createDoctorReferral,
  getDoctorCase,
  getDoctorDashboard,
  listDoctorCases,
  takeDoctorCase,
} from '../src/services/doctor.service.js'

const PATIENT_ID = '507f1f77bcf86cd799439011'
const DOCTOR_A = '507f191e810c19729de860ea'
const DOCTOR_B = '507f191e810c19729de860eb'
const VISIT_ID = '507f1f77bcf86cd799439012'
const CONSULTATION_ID = '507f1f77bcf86cd799439013'

function query(value) {
  return {
    select() { return this },
    populate() { return this },
    sort() { return this },
    limit() { return this },
    lean() { return Promise.resolve(typeof value === 'function' ? value() : value) },
    then(resolve, reject) { return Promise.resolve(typeof value === 'function' ? value() : value).then(resolve, reject) },
  }
}

function makePatient(overrides = {}) {
  return {
    _id: PATIENT_ID,
    fullName: 'Example Patient',
    dateOfBirth: new Date('1990-01-01'),
    gender: 'FEMALE',
    phone: '9876500000',
    address: { village: 'Example village', district: 'Example district' },
    createdBy: '507f191e810c19729de860ec',
    status: 'ACTIVE',
    caseStatus: 'NEW',
    assignedDoctor: null,
    assignedAt: null,
    createdAt: new Date(),
    ...overrides,
  }
}

function makeVisit(overrides = {}) {
  return {
    _id: VISIT_ID,
    patient: PATIENT_ID,
    visitDate: new Date('2026-09-10T10:00:00Z'),
    visitType: 'INITIAL',
    symptoms: { chiefComplaint: 'Fever', details: 'Reported for two days', durationDays: 2 },
    medicalHistory: ['Asthma'],
    allergies: ['Penicillin'],
    currentMedicines: ['Existing medicine'],
    vitals: { temperatureC: 38.2, oxygenSaturationPercent: 97, heartRateBpm: 90 },
    observations: 'Alert and speaking normally',
    followUp: { status: 'NOT_SCHEDULED', date: null },
    aiAssessment: {
      status: 'AI_ASSESSED', riskLevel: 'MEDIUM', riskScore: 48, priority: 'NORMAL',
      factors: ['Elevated temperature'], recommendation: 'Doctor review recommended.', assessedAt: new Date('2026-09-10T10:05:00Z'),
    },
    ...overrides,
  }
}

function saveStatics(statics) {
  const originals = Object.fromEntries(Object.entries(statics).map(([name, Model]) => [name, Model[name]]))
  return () => Object.entries(statics).forEach(([name, Model]) => { Model[name] = originals[name] })
}

test('a synchronized active patient appears in the doctor queue with its latest assessment', async () => {
  const restore = saveStatics({ find: Patient, visitFind: ASHAVisit, consultationFind: DoctorConsultation })
  const patient = makePatient()
  const visit = makeVisit()
  Patient.find = () => query([patient])
  ASHAVisit.find = () => query([visit])
  DoctorConsultation.find = () => query([])
  try {
    const cases = await listDoctorCases(DOCTOR_A)
    assert.equal(cases.length, 1)
    assert.equal(cases[0].patient.fullName, 'Example Patient')
    assert.equal(cases[0].latestVisit.aiAssessment.riskLevel, 'MEDIUM')
    assert.equal(cases[0].patient.assignedDoctor, null)
    assert.equal(patient.assignedDoctor, null, 'listing a case must not assign it')
  } finally {
    restore()
  }
})

test('doctor dashboard counts new, unassigned, high-risk, critical, assigned, and follow-up cases', async () => {
  const restore = saveStatics({ find: Patient, visitFind: ASHAVisit, consultationFind: DoctorConsultation })
  const previousNotificationFind = Notification.find
  const patients = [
    makePatient({ _id: PATIENT_ID, caseStatus: 'NEW', assignedDoctor: null }),
    makePatient({ _id: '507f1f77bcf86cd799439014', caseStatus: 'ACTIVE', assignedDoctor: { _id: DOCTOR_A, name: 'Doctor A' } }),
    makePatient({ _id: '507f1f77bcf86cd799439015', caseStatus: 'ACTIVE', assignedDoctor: null }),
  ]
  const visits = [
    makeVisit({ patient: PATIENT_ID, aiAssessment: { status: 'AI_ASSESSED', riskLevel: 'HIGH', riskScore: 76, priority: 'URGENT', factors: [], recommendation: 'Urgent doctor review recommended.' } }),
    makeVisit({ _id: '507f1f77bcf86cd799439016', patient: patients[1]._id, aiAssessment: { status: 'AI_ASSESSED', riskLevel: 'LOW', riskScore: 8, priority: 'ROUTINE', factors: [], recommendation: 'Routine doctor review recommended.' }, followUp: { status: 'SCHEDULED', date: new Date(Date.now() - 60_000) } }),
    makeVisit({ _id: '507f1f77bcf86cd799439017', patient: patients[2]._id, aiAssessment: { status: 'AI_ASSESSED', riskLevel: 'CRITICAL', riskScore: 96, priority: 'EMERGENCY', factors: [], recommendation: 'Emergency doctor review recommended.' } }),
  ]
  Patient.find = () => query(patients)
  ASHAVisit.find = () => query(visits)
  DoctorConsultation.find = () => query([])
  Notification.find = () => query([])
  try {
    const result = await getDoctorDashboard(DOCTOR_A)
    assert.equal(result.summary.unassignedCases, 2)
    assert.equal(result.summary.myActiveCases, 1)
    assert.equal(result.summary.highRiskCases, 1)
    assert.equal(result.summary.criticalCases, 1)
    assert.equal(result.summary.followUps, 1)
    assert.deepEqual(result.summary.notifications, [])
  } finally {
    restore()
    Notification.find = previousNotificationFind
  }
})

test('case details include demographics, clinical records, AI assessment, and a combined timeline', async () => {
  const restore = saveStatics({ findOne: Patient, visitFind: ASHAVisit, consultationFind: DoctorConsultation, prescriptionFind: Prescription, referralFind: Referral })
  Patient.findOne = () => query(makePatient({ assignedDoctor: { _id: DOCTOR_A, name: 'Doctor A' }, caseStatus: 'ACTIVE' }))
  ASHAVisit.find = () => query([
    makeVisit(),
    makeVisit({ _id: '507f1f77bcf86cd799439018', visitType: 'FOLLOW_UP', visitDate: new Date('2026-09-15'), symptoms: { chiefComplaint: 'Symptoms improving' }, followUpConsultation: CONSULTATION_ID }),
  ])
  const consultation = { _id: CONSULTATION_ID, patient: PATIENT_ID, doctor: { name: 'Doctor A' }, createdAt: new Date('2026-09-11'), notes: 'Reviewed', assessment: 'Likely viral illness', treatmentPlan: 'Observation', followUpDate: new Date('2026-10-05'), followUpStatus: 'PENDING' }
  DoctorConsultation.find = (filter) => query(filter.followUpStatus ? [] : [consultation])
  Prescription.find = () => query([
    { _id: 'prescription-1', patient: PATIENT_ID, items: [{ medicine: 'Example medicine', dosage: '500 mg', frequency: 'Twice daily', duration: '3 days', instructions: 'After food' }, { medicine: 'Second medicine', dosage: '1 tablet', frequency: 'Daily', duration: '5 days' }], createdAt: new Date('2026-09-12') },
    { _id: 'prescription-2', patient: PATIENT_ID, items: [{ medicine: 'Historical medicine', dosage: '250 mg', frequency: 'Daily', duration: '2 days' }], createdAt: new Date('2026-09-14') },
  ])
  Referral.find = () => query([{ _id: 'referral-1', patient: PATIENT_ID, status: 'ACTIVE', reason: 'Further evaluation', createdAt: new Date('2026-09-13'), expiresAt: new Date('2026-09-20') }])
  try {
    const result = await getDoctorCase(PATIENT_ID, DOCTOR_A)
    assert.equal(result.patient.fullName, 'Example Patient')
    assert.equal(result.patient.assignedDoctor.isCurrentUser, true)
    assert.deepEqual(result.medicalHistory, ['Asthma'])
    assert.deepEqual(result.allergies, ['Penicillin'])
    assert.deepEqual(result.currentMedicines, ['Existing medicine'])
    assert.equal(result.visits[0].aiAssessment.riskLevel, 'MEDIUM')
    assert.equal(result.prescriptions[0].items.length, 2, 'prescription history keeps every medicine item')
    assert.equal(result.prescriptions[0].items[0].instructions, 'After food')
    assert.equal(result.prescriptions.length, 2, 'older prescriptions remain in history')
    assert.equal(result.timeline.length, 7)
    assert.equal(result.timeline[0].type, 'FOLLOW_UP_SCHEDULED')
    assert.equal(result.timeline[0].status, 'PENDING')
    assert.ok(result.timeline.some((event) => event.title === 'ASHA follow-up visit'))
  } finally {
    restore()
  }
})

test('taking a case is atomic and only one of two doctors can claim it', async () => {
  const restore = saveStatics({ findOne: Patient, findOneAndUpdate: Patient })
  const stored = makePatient()
  Patient.findOneAndUpdate = (filter, update) => query(() => {
    if (stored._id !== filter._id || stored.status !== 'ACTIVE' || stored.assignedDoctor) return null
    Object.assign(stored, update.$set)
    return { ...stored }
  })
  Patient.findOne = () => query(() => ({
    ...stored,
    assignedDoctor: stored.assignedDoctor ? { _id: stored.assignedDoctor, name: stored.assignedDoctor === DOCTOR_A ? 'Doctor A' : 'Doctor B' } : null,
  }))
  try {
    const outcomes = await Promise.allSettled([takeDoctorCase(PATIENT_ID, DOCTOR_A), takeDoctorCase(PATIENT_ID, DOCTOR_B)])
    assert.equal(outcomes.filter((item) => item.status === 'fulfilled').length, 1)
    const rejected = outcomes.find((item) => item.status === 'rejected')
    assert.equal(rejected.reason.statusCode, 409)
    assert.equal(stored.caseStatus, 'ACTIVE')
    assert.ok([DOCTOR_A, DOCTOR_B].includes(stored.assignedDoctor))
  } finally {
    restore()
  }
})

test('doctor clinical writes require case ownership and keep consultation and prescription separate', async () => {
  const restore = saveStatics({ findOne: Patient, visitFindOne: ASHAVisit, consultationCreate: DoctorConsultation, consultationFindOne: DoctorConsultation, prescriptionCreate: Prescription })
  const previousNotificationBulkWrite = Notification.bulkWrite
  Patient.findOne = () => query(makePatient({ assignedDoctor: { _id: DOCTOR_A, name: 'Doctor A' }, caseStatus: 'ACTIVE' }))
  let createdConsultation
  DoctorConsultation.create = async (document) => { createdConsultation = { _id: CONSULTATION_ID, ...document }; return createdConsultation }
  let notificationWrites = []
  Notification.bulkWrite = async (operations) => { notificationWrites = operations; return {} }
  const consultationQuery = query({ _id: CONSULTATION_ID })
  DoctorConsultation.findOne = () => consultationQuery
  let createdPrescription
  Prescription.create = async (document) => { createdPrescription = { _id: 'prescription-1', ...document }; return createdPrescription }
  try {
    const consultation = await createDoctorConsultation(PATIENT_ID, DOCTOR_A, {
      notes: 'Clinical notes', assessment: 'Assessment text', treatmentPlan: 'Plan entered by doctor', priority: 'HIGH',
      followUpDate: new Date(Date.now() + 48 * 60 * 60 * 1000).toISOString(),
    })
    assert.equal(consultation.treatmentPlan, 'Plan entered by doctor')
    assert.equal(consultation.doctor, DOCTOR_A)
    assert.equal(consultation.followUpStatus, 'PENDING')
    assert.equal(notificationWrites.length, 2, 'doctor and ASHA receive a follow-up reminder')
    const prescription = await createDoctorPrescription(PATIENT_ID, DOCTOR_A, {
      consultationId: CONSULTATION_ID,
      items: [
        { medicine: 'Doctor selected medicine', dosage: '1 tablet', frequency: 'Twice daily', duration: '3 days', instructions: 'After food' },
        { medicine: 'Second doctor selected medicine', dosage: '250 mg', frequency: 'Daily', duration: '5 days' },
      ],
    })
    assert.equal(prescription.consultation, CONSULTATION_ID)
    assert.equal(prescription.patient, PATIENT_ID)
    assert.equal(createdPrescription.items[0].medicine, 'Doctor selected medicine')
    assert.equal(createdPrescription.items.length, 2)
    assert.equal(createdPrescription.items[0].instructions, 'After food')
    Patient.findOne = () => query(makePatient({ assignedDoctor: { _id: DOCTOR_B, name: 'Doctor B' }, caseStatus: 'ACTIVE' }))
    await assert.rejects(
      createDoctorConsultation(PATIENT_ID, DOCTOR_A, { notes: 'Not allowed' }),
      (error) => error.statusCode === 409 && error.code === 'CASE_NOT_ASSIGNED_TO_DOCTOR',
    )
  } finally {
    restore()
    Notification.bulkWrite = previousNotificationBulkWrite
  }
})

test('doctor referral stores a token hash and returns the raw token only at creation', async () => {
  const restore = saveStatics({ findOne: Patient, consultationFindOne: DoctorConsultation, referralCreate: Referral })
  Patient.findOne = () => query(makePatient({ assignedDoctor: { _id: DOCTOR_A, name: 'Doctor A' }, caseStatus: 'ACTIVE' }))
  DoctorConsultation.findOne = () => query({ _id: CONSULTATION_ID })
  let savedReferral
  Referral.create = async (document) => { savedReferral = document; return { _id: 'referral-1', status: 'ACTIVE', reason: document.reason, expiresAt: document.expiresAt } }
  try {
    const result = await createDoctorReferral(PATIENT_ID, DOCTOR_A, { consultationId: CONSULTATION_ID, reason: 'Needs further evaluation' })
    assert.ok(result.token.length > 30)
    assert.notEqual(savedReferral.tokenHash, result.token)
    assert.equal(result.referral.reason, 'Needs further evaluation')
    assert.equal(savedReferral.ashaWorker, '507f191e810c19729de860ec')
  } finally {
    restore()
  }
})

test('doctor router requires a doctor role; ASHA and ADMIN are forbidden from case actions', () => {
  assert.equal(doctorRouter.stack[0].handle, requireAuth)
  const checkDoctorRole = doctorRouter.stack.find((layer) => layer.handle.name === 'checkRole')?.handle
  assert.equal(typeof checkDoctorRole, 'function')
  for (const role of ['ASHA_WORKER', 'ADMIN']) {
    let error
    checkDoctorRole({ user: { role } }, {}, (nextError) => { error = nextError })
    assert.equal(error.statusCode, 403)
    assert.equal(error.code, 'ROLE_FORBIDDEN')
  }
  const allowDoctor = requireRole('DOCTOR')
  let error = null
  allowDoctor({ user: { role: 'DOCTOR' } }, {}, (nextError) => { error = nextError || null })
  assert.equal(error, null)
})
