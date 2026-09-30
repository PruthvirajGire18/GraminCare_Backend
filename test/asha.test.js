import assert from 'node:assert/strict'
import test from 'node:test'
import {
  createPatient,
  createVisit,
  getPatientProfile,
  sharePatientWithWorker,
  validateClientOperationId,
  validatePatientPayload,
  validateVisitPayload,
} from '../src/services/asha.service.js'
import Patient from '../src/models/Patient.js'
import ASHAVisit from '../src/models/ASHAVisit.js'
import DoctorConsultation from '../src/models/DoctorConsultation.js'
import Notification from '../src/models/Notification.js'
import User from '../src/models/User.js'
import { markMissedFollowUps } from '../src/services/followUp.service.js'

test('patient validation requires a valid name and supported gender', () => {
  assert.throws(() => validatePatientPayload({ fullName: 'A', gender: 'FEMALE' }), (error) => error.statusCode === 400)
  assert.throws(() => validatePatientPayload({ fullName: 'Example Patient', gender: 'HOSPITAL' }), (error) => error.statusCode === 400)
})

test('patient validation rejects future birth dates and malformed phone numbers', () => {
  assert.throws(() => validatePatientPayload({ fullName: 'Example Patient', gender: 'FEMALE', dateOfBirth: '2999-01-01' }), (error) => error.statusCode === 400)
  assert.throws(() => validatePatientPayload({ fullName: 'Example Patient', gender: 'FEMALE', phone: 'call-me' }), (error) => error.statusCode === 400)
})

test('visit validation accepts field data and a scheduled follow-up', () => {
  const visit = validateVisitPayload({
    visitType: 'INITIAL',
    symptoms: { chiefComplaint: 'Fever for two days', details: 'Mild chills' },
    medicalHistory: ['Asthma'],
    allergies: ['Pollen'],
    currentMedicines: ['Example medicine'],
    vitals: { temperatureC: 38.2, heartRateBpm: 92, systolicMmHg: 118, diastolicMmHg: 76 },
    observations: 'Alert and responsive',
    followUp: { date: '2026-10-07' },
  })
  assert.equal(visit.visitType, 'INITIAL')
  assert.equal(visit.vitals.temperatureC, 38.2)
  assert.equal(visit.followUp.status, 'SCHEDULED')
})

test('visit validation rejects out-of-range vitals and incomplete follow-up links', () => {
  assert.throws(() => validateVisitPayload({ symptoms: { chiefComplaint: 'Fever' }, vitals: { oxygenSaturationPercent: 120 } }), (error) => error.statusCode === 400)
  assert.throws(() => validateVisitPayload({ visitType: 'FOLLOW_UP', symptoms: { chiefComplaint: 'Review' } }), (error) => error.statusCode === 400)
})

test('visit validation accepts a doctor consultation follow-up link and prevents ambiguous links', () => {
  const visit = validateVisitPayload({
    visitType: 'FOLLOW_UP',
    followUpConsultationId: '507f1f77bcf86cd799439013',
    symptoms: { chiefComplaint: 'Review of symptoms' },
  })
  assert.equal(visit.followUpConsultation, '507f1f77bcf86cd799439013')
  assert.equal(visit.followUpOf, null)
  assert.throws(() => validateVisitPayload({
    visitType: 'FOLLOW_UP',
    followUpOf: '507f1f77bcf86cd799439012',
    followUpConsultationId: '507f1f77bcf86cd799439013',
    symptoms: { chiefComplaint: 'Review of symptoms' },
  }), (error) => error.statusCode === 400)
})

test('patient profile and ASHA visit records remain separate models', async () => {
  const ASHAVisit = (await import('../src/models/ASHAVisit.js')).default
  const DoctorConsultation = (await import('../src/models/DoctorConsultation.js')).default
  assert.equal(Patient.schema.path('createdBy').options.ref, 'User')
  assert.equal(ASHAVisit.schema.path('patient').options.ref, 'Patient')
  assert.equal(ASHAVisit.schema.path('ashaWorker').options.ref, 'User')
  assert.equal(DoctorConsultation.schema.path('ashaVisit').options.ref, 'ASHAVisit')
  assert.equal(DoctorConsultation.schema.path('notes').options.required, true)
  assert.equal(ASHAVisit.schema.path('symptoms.chiefComplaint').options.required, true)
})

test('patient profile lookups are scoped to the authenticated ASHA owner', async () => {
  const previousFindOne = Patient.findOne
  const patientId = '507f1f77bcf86cd799439011'
  const ashaWorkerId = '507f191e810c19729de860ea'
  let query
  Patient.findOne = async (filter) => {
    query = filter
    return null
  }

  try {
    await assert.rejects(
      getPatientProfile(patientId, ashaWorkerId),
      (error) => error.statusCode === 404,
    )
    assert.equal(query._id, patientId)
    assert.deepEqual(query.$or, [{ createdBy: ashaWorkerId }, { ashaWorkers: ashaWorkerId }])
    assert.equal(query.status, 'ACTIVE')
  } finally {
    Patient.findOne = previousFindOne
  }
})

test('a patient owner can share with an approved ASHA worker but a teammate cannot reshare', async () => {
  const previousPatientFindOne = Patient.findOne
  const previousUserFindOne = User.findOne
  const ownerId = '507f191e810c19729de860ea'
  const teammateId = '507f191e810c19729de860eb'
  const patient = {
    _id: '507f1f77bcf86cd799439011',
    createdBy: { toString: () => ownerId },
    ashaWorkers: [{ toString: () => ownerId }],
    version: 1,
    clientOperationId: 'initial-patient-operation',
    async save() {},
  }
  Patient.findOne = async () => patient
  User.findOne = async () => ({ _id: { toString: () => teammateId }, role: 'ASHA_WORKER', status: 'APPROVED' })

  try {
    const shared = await sharePatientWithWorker(patient._id, {
      email: 'asha-b@example.test',
      baseVersion: 1,
      clientOperationId: 'share-operation-identifier',
    }, ownerId)
    assert.equal(shared.version, 2)
    assert.equal(shared.updatedBy, ownerId)
    assert.ok(shared.ashaWorkers.some((workerId) => workerId.toString() === teammateId))
    await assert.rejects(
      sharePatientWithWorker(patient._id, { email: 'asha-c@example.test', baseVersion: 2, clientOperationId: 'reshare-operation-identifier' }, teammateId),
      (error) => error.statusCode === 403,
    )
  } finally {
    Patient.findOne = previousPatientFindOne
    User.findOne = previousUserFindOne
  }
})

test('client operation IDs are required and bounded for offline-safe creates', () => {
  assert.equal(validateClientOperationId('d1a37387-65cc-40e6-8766-33e52761f7cb'), 'd1a37387-65cc-40e6-8766-33e52761f7cb')
  assert.throws(() => validateClientOperationId('short'), (error) => error.statusCode === 400)
  assert.throws(() => validateClientOperationId('invalid id with spaces'), (error) => error.statusCode === 400)
})

test('patient and visit schemas enforce worker-scoped unique idempotency indexes', async () => {
  const indexes = [
    ...Patient.schema.indexes(),
    ...ASHAVisit.schema.indexes(),
  ]
  assert.ok(indexes.some(([keys, options]) => keys.createdBy && keys.clientOperationId && options.unique))
  assert.ok(indexes.some(([keys, options]) => keys.ashaWorker && keys.clientOperationId && options.unique))
})

test('patient create replay returns the already-created patient for the same operation ID', async () => {
  const previousFindOne = Patient.findOne
  const existing = { _id: '507f1f77bcf86cd799439011', fullName: 'Example Patient', status: 'ACTIVE' }
  let lookup
  Patient.findOne = async (filter) => {
    lookup = filter
    return existing
  }

  try {
    const result = await createPatient({
      fullName: 'Example Patient',
      gender: 'UNKNOWN',
      address: {},
      clientOperationId: 'd1a37387-65cc-40e6-8766-33e52761f7cb',
    }, '507f191e810c19729de860ea')
    assert.equal(result.created, false)
    assert.equal(result.patient, existing)
    assert.equal(lookup.clientOperationId, 'd1a37387-65cc-40e6-8766-33e52761f7cb')
  } finally {
    Patient.findOne = previousFindOne
  }
})

test('visit create replay returns the existing visit without completing follow-up twice', async () => {
  const previousPatientFindOne = Patient.findOne
  const previousVisitFindOne = ASHAVisit.findOne
  const patient = { _id: '507f1f77bcf86cd799439011', status: 'ACTIVE' }
  const existingVisit = { _id: '507f191e810c19729de860ea', visitType: 'FOLLOW_UP' }
  let followUpMutation = false
  Patient.findOne = async () => patient
  ASHAVisit.findOne = async () => existingVisit

  try {
    const result = await createVisit(patient._id, {
      visitType: 'FOLLOW_UP',
      followUpOf: '507f1f77bcf86cd799439012',
      clientOperationId: 'f39ea5f9-d41b-4607-b983-26aa5d12f0f1',
    }, '507f191e810c19729de860ea')
    assert.equal(result.created, false)
    assert.equal(result.visit, existingVisit)
    assert.equal(followUpMutation, false)
  } finally {
    Patient.findOne = previousPatientFindOne
    ASHAVisit.findOne = previousVisitFindOne
  }
})

test('an ASHA follow-up completes the linked doctor consultation and sends a doctor notification', async () => {
  const previousPatientFindOne = Patient.findOne
  const previousVisitFindOne = ASHAVisit.findOne
  const previousVisitCreate = ASHAVisit.create
  const previousConsultationFindOne = DoctorConsultation.findOne
  const previousConsultationUpdateOne = DoctorConsultation.updateOne
  const previousNotificationBulkWrite = Notification.bulkWrite
  const previousNotificationUpdateMany = Notification.updateMany
  const patient = {
    _id: '507f1f77bcf86cd799439011',
    fullName: 'Example Patient',
    createdBy: '507f191e810c19729de860ea',
    ashaWorkers: ['507f191e810c19729de860ea'],
    status: 'ACTIVE',
  }
  const consultation = {
    _id: '507f1f77bcf86cd799439013',
    patient: patient._id,
    doctor: '507f191e810c19729de860eb',
    followUpDate: new Date(Date.now() + 24 * 60 * 60 * 1000),
    followUpStatus: 'PENDING',
    followUpVisit: null,
  }
  const savedVisit = { _id: '507f1f77bcf86cd799439014', ...patient }
  let updateFilter
  let notificationOperations = []
  Patient.findOne = async () => patient
  ASHAVisit.findOne = async () => null
  ASHAVisit.create = async (record) => ({ _id: savedVisit._id, ...record })
  DoctorConsultation.findOne = async (filter) => {
    assert.equal(filter.patient, patient._id)
    return consultation
  }
  DoctorConsultation.updateOne = async (filter) => {
    updateFilter = filter
    return { matchedCount: 1, modifiedCount: 1 }
  }
  Notification.bulkWrite = async (operations) => { notificationOperations = operations; return {} }
  Notification.updateMany = async () => ({ modifiedCount: 0 })

  try {
    const result = await createVisit(patient._id, {
      visitType: 'FOLLOW_UP',
      followUpConsultationId: consultation._id,
      visitDate: new Date().toISOString(),
      symptoms: { chiefComplaint: 'Symptoms improving', details: 'No new concern' },
      vitals: { temperatureC: 36.8, oxygenSaturationPercent: 98 },
      observations: 'Patient reports improvement',
      clientOperationId: 'follow-up-operation-identifier',
    }, '507f191e810c19729de860ea')
    assert.equal(result.created, true)
    assert.equal(result.visit.followUpConsultation, consultation._id)
    assert.equal(updateFilter._id, consultation._id)
    assert.deepEqual(updateFilter.followUpStatus.$in, ['PENDING', 'MISSED'])
    assert.equal(notificationOperations.length, 1)
    assert.equal(notificationOperations[0].updateOne.update.$setOnInsert.recipientRole, 'DOCTOR')
  } finally {
    Patient.findOne = previousPatientFindOne
    ASHAVisit.findOne = previousVisitFindOne
    ASHAVisit.create = previousVisitCreate
    DoctorConsultation.findOne = previousConsultationFindOne
    DoctorConsultation.updateOne = previousConsultationUpdateOne
    Notification.bulkWrite = previousNotificationBulkWrite
    Notification.updateMany = previousNotificationUpdateMany
  }
})

test('past doctor follow-ups transition to MISSED and notify their doctor and ASHA worker', async () => {
  const previousFind = DoctorConsultation.find
  const previousUpdateOne = DoctorConsultation.updateOne
  const previousNotificationBulkWrite = Notification.bulkWrite
  const previousNotificationUpdateMany = Notification.updateMany
  const dueDate = new Date()
  dueDate.setDate(dueDate.getDate() - 1)
  const consultation = {
    _id: '507f1f77bcf86cd799439013',
    doctor: '507f191e810c19729de860eb',
    followUpDate: dueDate,
    followUpStatus: 'PENDING',
    patient: {
      _id: '507f1f77bcf86cd799439011',
      fullName: 'Example Patient',
      createdBy: '507f191e810c19729de860ea',
      ashaWorkers: ['507f191e810c19729de860ea'],
    },
  }
  let update
  let notifications = []
  DoctorConsultation.find = () => ({
    populate() { return this },
    lean() { return Promise.resolve([consultation]) },
  })
  DoctorConsultation.updateOne = async (_filter, change) => {
    update = change
    return { modifiedCount: 1 }
  }
  Notification.bulkWrite = async (operations) => { notifications = operations; return {} }
  Notification.updateMany = async () => ({ modifiedCount: 0 })
  try {
    const marked = await markMissedFollowUps()
    assert.equal(marked, 1)
    assert.equal(update.$set.followUpStatus, 'MISSED')
    assert.equal(notifications.length, 2)
    assert.ok(notifications.every((operation) => operation.updateOne.update.$setOnInsert.type === 'FOLLOW_UP_MISSED'))
  } finally {
    DoctorConsultation.find = previousFind
    DoctorConsultation.updateOne = previousUpdateOne
    Notification.bulkWrite = previousNotificationBulkWrite
    Notification.updateMany = previousNotificationUpdateMany
  }
})
