import assert from 'node:assert/strict'
import test from 'node:test'
import ASHAVisit from '../src/models/ASHAVisit.js'
import doctorRouter from '../src/routes/doctor.routes.js'
import { postVisit } from '../src/controllers/asha.controller.js'
import {
  AIRiskServiceError,
  buildRiskInput,
  createMockRiskAssessment,
  generateRiskAssessment,
  validateRiskAssessment,
} from '../src/services/aiRisk.service.js'
import { processRiskAssessment } from '../src/services/aiRiskQueue.service.js'
import { doctorAssessmentDto, listDoctorAssessments } from '../src/services/doctor.service.js'

function sampleInput(overrides = {}) {
  return {
    ageYears: 32,
    gender: 'FEMALE',
    symptoms: { chiefComplaint: 'Routine check-up', details: '', durationDays: null },
    vitals: {
      temperatureC: null,
      oxygenSaturationPercent: null,
      heartRateBpm: null,
      respiratoryRatePerMinute: null,
      systolicMmHg: null,
      diastolicMmHg: null,
    },
    medicalHistory: [],
    allergies: [],
    currentMedicines: [],
    ashaObservations: '',
    ...overrides,
  }
}

function modelStub({ visit, patient, updates = [] }) {
  return {
    visitModel: {
      findOneAndUpdate() {
        return { select: async () => visit }
      },
      async updateOne(filter, update) { updates.push({ filter, update }) },
    },
    patientModel: {
      findById() {
        return {
          select() { return this },
          lean() { return Promise.resolve(patient) },
        }
      },
    },
    updates,
  }
}

test('deterministic mock mode maps routine, moderate, high, and critical signals', () => {
  assert.equal(createMockRiskAssessment(sampleInput()).riskLevel, 'LOW')
  assert.equal(createMockRiskAssessment(sampleInput({ symptoms: { chiefComplaint: 'Moderate symptoms', details: '', durationDays: null } })).riskLevel, 'MEDIUM')
  assert.equal(createMockRiskAssessment(sampleInput({
    symptoms: { chiefComplaint: 'Fever and cough', details: '', durationDays: null },
    vitals: { ...sampleInput().vitals, temperatureC: 38.2 },
  })).riskLevel, 'MEDIUM')
  const high = createMockRiskAssessment(sampleInput({
    symptoms: { chiefComplaint: 'Breathing difficulty', details: '', durationDays: null },
    vitals: { ...sampleInput().vitals, oxygenSaturationPercent: 89 },
  }))
  assert.equal(high.riskLevel, 'HIGH')
  assert.equal(high.priority, 'URGENT')
  const critical = createMockRiskAssessment(sampleInput({
    vitals: { ...sampleInput().vitals, oxygenSaturationPercent: 82 },
  }))
  assert.equal(critical.riskLevel, 'CRITICAL')
  assert.equal(critical.priority, 'EMERGENCY')
  assert.equal(critical.riskScore, 94)
})

test('mock mode is deterministic and returns the required structured assessment', async () => {
  const input = sampleInput({ symptoms: { chiefComplaint: 'Fever', details: '', durationDays: null } })
  const first = await generateRiskAssessment(input, { mode: 'mock' })
  const second = await generateRiskAssessment(input, { mode: 'mock' })
  assert.deepEqual(first, second)
  assert.deepEqual(Object.keys(first).sort(), ['factors', 'mode', 'model', 'priority', 'recommendation', 'riskLevel', 'riskScore'].sort())
})

test('AI payload uses clinical signals and removes patient names and direct identifiers', () => {
  const input = buildRiskInput({
    patient: {
      fullName: 'Priya Sample',
      gender: 'FEMALE',
      dateOfBirth: '1990-01-01',
      phone: '+91 98765 43210',
      address: { details: 'Private address' },
    },
    visit: {
      symptoms: { chiefComplaint: 'Priya Sample reports fever; call 9876543210', details: 'email patient@example.test', durationDays: 2 },
      vitals: { temperatureC: 38.1, oxygenSaturationPercent: 98 },
      observations: 'Contact Priya Sample at +91 98765 43210',
    },
  })
  const serialized = JSON.stringify(input)
  assert.doesNotMatch(serialized, /Priya Sample|9876543210|patient@example\.test|Private address/)
  assert.equal(input.vitals.temperatureC, 38.1)
  assert.equal(input.symptoms.durationDays, 2)
  assert.equal(input.ageYears, new Date().getFullYear() - 1990)
  assert.equal(Object.hasOwn(input, 'phone'), false)
})

test('real API mode reports an unavailable provider and rejects malformed structured output', async () => {
  await assert.rejects(
    generateRiskAssessment(sampleInput(), { mode: 'openai', apiKey: 'test-key', fetchImpl: async () => { throw new Error('offline') } }),
    (error) => error instanceof AIRiskServiceError && error.code === 'AI_UNAVAILABLE',
  )
  await assert.rejects(
    generateRiskAssessment(sampleInput(), {
      mode: 'openai',
      apiKey: 'test-key',
      fetchImpl: async () => ({ ok: true, json: async () => ({ choices: [{ message: { content: '{broken' } }] }) }),
    }),
    (error) => error.code === 'INVALID_AI_RESPONSE',
  )
})

test('real API mode sends the strict schema from the backend and accepts a valid response', async () => {
  let requestUrl
  let requestOptions
  const input = buildRiskInput({
    patient: { fullName: 'Private Patient', gender: 'FEMALE', dateOfBirth: '1990-01-01', phone: '9876543210' },
    visit: { symptoms: { chiefComplaint: 'Private Patient has fever', details: '', durationDays: 1 }, vitals: { temperatureC: 38.2 } },
  })
  const result = await generateRiskAssessment(input, {
    mode: 'openai',
    apiKey: 'test-only-key',
    model: 'gpt-4o-mini',
    fetchImpl: async (url, options) => {
      requestUrl = url
      requestOptions = options
      return {
        ok: true,
        json: async () => ({ choices: [{ message: { content: JSON.stringify({
          riskLevel: 'MEDIUM', riskScore: 48, priority: 'NORMAL', factors: ['Elevated temperature'],
          recommendation: 'Doctor review recommended.',
        }) } }] }),
      }
    },
  })
  const requestBody = JSON.parse(requestOptions.body)
  assert.equal(requestUrl, 'https://api.openai.com/v1/chat/completions')
  assert.equal(requestOptions.headers.Authorization, 'Bearer test-only-key')
  assert.equal(requestBody.response_format.json_schema.strict, true)
  assert.equal(requestBody.store, false)
  assert.doesNotMatch(requestBody.messages[1].content, /Private Patient|9876543210|fullName/)
  assert.equal(result.mode, 'openai')
  assert.equal(result.riskLevel, 'MEDIUM')
})

test('validation rejects invalid risk data and any attempt to add a prescription field', () => {
  assert.throws(() => validateRiskAssessment({ riskLevel: 'DANGER' }), (error) => error.code === 'INVALID_AI_RESPONSE')
  assert.throws(() => validateRiskAssessment({
    riskLevel: 'HIGH', riskScore: 90, priority: 'URGENT', factors: [], recommendation: 'Urgent doctor review recommended.', prescription: 'Drug X',
  }), (error) => error.code === 'INVALID_AI_RESPONSE')
  assert.throws(() => validateRiskAssessment({
    riskLevel: 'HIGH', riskScore: 90, priority: 'URGENT', factors: [], recommendation: 'Take paracetamol 500 mg now.',
  }), (error) => error.code === 'INVALID_AI_RESPONSE')
})

test('failed AI assessment returns visit to pending with a retry time', async () => {
  const visit = {
    _id: 'visit-1', patient: 'patient-1', symptoms: {}, aiAssessment: { attempts: 1 },
  }
  const stub = modelStub({ visit, patient: { gender: 'UNKNOWN' } })
  const result = await processRiskAssessment('visit-1', {
    ...stub,
    assessor: async () => { throw new AIRiskServiceError('AI_UNAVAILABLE') },
  })
  assert.equal(result.status, 'AI_ASSESSMENT_PENDING')
  assert.equal(result.errorCode, 'AI_UNAVAILABLE')
  const set = stub.updates.at(-1).update.$set
  assert.equal(set['aiAssessment.status'], 'AI_ASSESSMENT_PENDING')
  assert.equal(set['aiAssessment.lastErrorCode'], 'AI_UNAVAILABLE')
  assert.ok(set['aiAssessment.nextAttemptAt'] instanceof Date)
})

test('visit synchronization response succeeds even if assessment enqueue fails', async () => {
  const response = {
    statusCode: 0,
    body: null,
    status(code) { this.statusCode = code; return this },
    json(value) { this.body = value; return this },
  }
  await postVisit(
    { params: { patientId: 'patient-1' }, body: {}, user: { _id: { toString: () => 'worker-1' } } },
    response,
    {
      createVisitFn: async () => ({ created: true, visit: { _id: 'visit-1' } }),
      enqueueAssessmentFn: () => { throw new Error('queue unavailable') },
    },
  )
  assert.equal(response.statusCode, 201)
  assert.equal(response.body.success, true)
})

test('doctor assessment projection includes AI results while ASHA serialization hides them', () => {
  const projection = doctorAssessmentDto({
    _id: 'visit-1', visitDate: new Date('2026-01-01'),
    patient: { _id: 'patient-1', fullName: 'Example Patient', gender: 'FEMALE' },
    symptoms: { chiefComplaint: 'Fever' },
    aiAssessment: { status: 'AI_ASSESSED', riskLevel: 'MEDIUM', riskScore: 48, priority: 'NORMAL', factors: ['Elevated temperature'], recommendation: 'Doctor review recommended.' },
  })
  assert.equal(projection.assessment.riskLevel, 'MEDIUM')
  assert.equal(Object.hasOwn(projection.patient, 'dateOfBirth'), false)
  const ashaJson = new ASHAVisit({
    patient: '507f1f77bcf86cd799439011', ashaWorker: '507f191e810c19729de860ea', updatedBy: '507f191e810c19729de860ea',
    clientOperationId: 'sample-operation-id', visitType: 'INITIAL', symptoms: { chiefComplaint: 'Fever' },
    aiAssessment: { status: 'AI_ASSESSED', riskLevel: 'HIGH', riskScore: 75 },
  }).toJSON()
  assert.equal(Object.hasOwn(ashaJson, 'aiAssessment'), false)
})

test('doctor assessment query returns the attached assessment for the existing visit', async () => {
  const previousFind = ASHAVisit.find
  const savedVisit = {
    _id: 'visit-1',
    visitDate: new Date('2026-01-01'),
    patient: { _id: 'patient-1', fullName: 'Example Patient', gender: 'FEMALE', status: 'ACTIVE' },
    symptoms: { chiefComplaint: 'Persistent cough' },
    aiAssessment: { status: 'AI_ASSESSED', riskLevel: 'HIGH', riskScore: 74, priority: 'URGENT', factors: ['Persistent symptoms'], recommendation: 'Urgent doctor review recommended.' },
  }
  ASHAVisit.find = () => {
    const query = {
      select() { return this },
      populate() { return this },
      sort() { return this },
      limit() { return this },
      lean() { return Promise.resolve([savedVisit]) },
    }
    return query
  }
  try {
    const assessments = await listDoctorAssessments()
    assert.equal(assessments.length, 1)
    assert.equal(assessments[0].visitId, 'visit-1')
    assert.equal(assessments[0].assessment.riskLevel, 'HIGH')
  } finally {
    ASHAVisit.find = previousFind
  }
})

test('doctor router keeps assessment reads and clinical writes behind the doctor role', () => {
  const endpoints = doctorRouter.stack.filter((layer) => layer.route).map((layer) => ({
    path: layer.route.path,
    methods: Object.keys(layer.route.methods),
  }))
  assert.deepEqual(endpoints, [
    { path: '/dashboard', methods: ['get'] },
    { path: '/cases', methods: ['get'] },
    { path: '/cases/:patientId', methods: ['get'] },
    { path: '/cases/:patientId/take', methods: ['post'] },
    { path: '/cases/:patientId/consultations', methods: ['post'] },
    { path: '/cases/:patientId/prescriptions', methods: ['post'] },
    { path: '/cases/:patientId/referrals', methods: ['post'] },
    { path: '/assessments', methods: ['get'] },
  ])
})
