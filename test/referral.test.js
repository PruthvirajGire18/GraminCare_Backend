import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import test from 'node:test'
import Notification from '../src/models/Notification.js'
import Patient from '../src/models/Patient.js'
import Referral from '../src/models/Referral.js'
import ReferralAudit from '../src/models/ReferralAudit.js'
import { env } from '../src/config/env.js'
import { createReferralRateLimiter } from '../src/middleware/referralRateLimit.middleware.js'
import {
  getAshaReferralQr,
  issueReferral,
  revokeDoctorReferral,
  verifyReferralToken,
} from '../src/services/referral.service.js'

const PATIENT_ID = '507f1f77bcf86cd799439011'
const DOCTOR_ID = '507f191e810c19729de860ea'
const ASHA_ID = '507f191e810c19729de860ec'
const REFERRAL_ID = '507f1f77bcf86cd799439019'
const TEST_SECRET = 'test-only-referral-encryption-secret-with-32-bytes'

function query(value) {
  const resolveValue = () => typeof value === 'function' ? value() : value
  return {
    select() { return this },
    populate() { return this },
    then(resolve, reject) { return Promise.resolve().then(resolveValue).then(resolve, reject) },
  }
}

function saveStatics(entries) {
  const originals = Object.fromEntries(Object.entries(entries).map(([key, [model, method]]) => [key, model[method]]))
  return () => Object.entries(entries).forEach(([key, [model, method]]) => { model[method] = originals[key] })
}

function setupMocks({ status = 'ACTIVE', expiresAt = new Date(Date.now() + 60_000), ashaOwnsReferral = true } = {}) {
  const savedSecret = env.jwtSecret
  env.jwtSecret = TEST_SECRET
  const record = {
    _id: REFERRAL_ID,
    patient: PATIENT_ID,
    doctor: { _id: DOCTOR_ID, name: 'Dr Example' },
    ashaWorker: ASHA_ID,
    reason: 'Urgent further evaluation',
    priority: 'CRITICAL',
    destination: { facilityName: 'District clinic', address: 'Clinic road' },
    tokenHash: '',
    status,
    createdAt: new Date(),
    expiresAt,
  }
  const audits = []
  const notificationOps = []
  let findOneAndUpdateCalls = 0
  const restore = saveStatics({
    create: [Referral, 'create'],
    findOne: [Referral, 'findOne'],
    findOneAndUpdate: [Referral, 'findOneAndUpdate'],
    updateOne: [Referral, 'updateOne'],
    patientFindOne: [Patient, 'findOne'],
    auditCreate: [ReferralAudit, 'create'],
    notificationBulkWrite: [Notification, 'bulkWrite'],
    notificationUpdateMany: [Notification, 'updateMany'],
  })
  Referral.create = async (document) => Object.assign(record, document, { _id: REFERRAL_ID, status: 'ACTIVE', createdAt: new Date() })
  Referral.findOne = (filter) => query(() => {
    if (filter.tokenHash && filter.tokenHash !== record.tokenHash) return null
    if (filter._id && filter._id !== record._id) return null
    if (filter.patient && filter.patient !== record.patient) return null
    if (filter.doctor && filter.doctor !== record.doctor?._id && filter.doctor !== record.doctor) return null
    return { ...record, doctor: { ...record.doctor } }
  })
  Referral.findOneAndUpdate = (filter, update) => query(() => {
    findOneAndUpdateCalls += 1
    if (filter._id !== record._id || record.status !== filter.status || record.expiresAt <= new Date()) return null
    Object.assign(record, update.$set)
    return { ...record, doctor: { ...record.doctor } }
  })
  Referral.updateOne = async (filter, update) => {
    if (filter._id !== record._id || record.status !== 'ACTIVE' || record.expiresAt > new Date()) return { matchedCount: 0, modifiedCount: 0 }
    Object.assign(record, update.$set)
    return { matchedCount: 1, modifiedCount: 1 }
  }
  Patient.findOne = () => query(ashaOwnsReferral ? { _id: PATIENT_ID } : null)
  ReferralAudit.create = async (audit) => { audits.push(audit); return audit }
  Notification.bulkWrite = async (operations) => { notificationOps.push(...operations); return {} }
  Notification.updateMany = async () => ({ modifiedCount: 1 })

  return {
    record,
    audits,
    notificationOps,
    get findOneAndUpdateCalls() { return findOneAndUpdateCalls },
    restore() {
      restore()
      env.jwtSecret = savedSecret
    },
  }
}

test('QR generation returns a random token only in the verification URL fragment', async () => {
  const mocks = setupMocks()
  try {
    const issued = await issueReferral({
      patient: { _id: PATIENT_ID, createdBy: ASHA_ID, ashaWorkers: [] },
      consultation: { _id: '507f1f77bcf86cd799439013' },
      doctorId: DOCTOR_ID,
      reason: 'Urgent further evaluation',
      priority: 'CRITICAL',
      destination: { facilityName: 'District clinic', address: 'Clinic road' },
    })
    assert.equal(issued.token, undefined, 'the doctor response must not contain the bearer token')
    assert.match(mocks.record.tokenHash, /^[a-f\d]{64}$/)
    assert.ok(mocks.record.tokenCiphertext)
    assert.equal(mocks.audits[0].action, 'REFERRAL_CREATED')
    assert.equal(Object.hasOwn(mocks.audits[0], 'reason'), false)

    const qr = await getAshaReferralQr(REFERRAL_ID, ASHA_ID)
    const token = qr.verificationUrl.split('#')[1]
    assert.match(token, /^REF-[a-f\d]{64}$/)
    assert.equal(createHash('sha256').update(token).digest('hex'), mocks.record.tokenHash)
    assert.equal(qr.verificationUrl.split('#')[0], '/referral/verify')
    const resolvedQrLink = new URL(qr.verificationUrl, 'http://localhost:5174')
    assert.equal(resolvedQrLink.origin, 'http://localhost:5174')
    assert.equal(resolvedQrLink.search, '')
    assert.equal(qr.verificationUrl.split('?').length, 1)
    assert.equal(mocks.audits.at(-1).action, 'REFERRAL_VIEWED')
    assert.ok(mocks.notificationOps.length > 0)
    assert.equal(JSON.stringify(mocks.notificationOps).includes('Urgent further evaluation'), false)
  } finally {
    mocks.restore()
  }
})

test('a valid QR token returns only referral details and is atomically used once', async () => {
  const mocks = setupMocks()
  mocks.record.tokenHash = createHash('sha256').update(`REF-${'a'.repeat(64)}`).digest('hex')
  const token = `REF-${'a'.repeat(64)}`
  try {
    const [first, second] = await Promise.allSettled([
      verifyReferralToken(token),
      verifyReferralToken(token),
    ])
    assert.equal([first, second].filter((result) => result.status === 'fulfilled').length, 1)
    assert.equal([first, second].filter((result) => result.status === 'rejected').length, 1)
    const result = first.status === 'fulfilled' ? first.value : second.value
    assert.equal(result.patientReference, 'P9011')
    assert.equal(result.priority, 'CRITICAL')
    assert.equal(result.doctorName, 'Dr Example')
    assert.equal(result.status, 'USED')
    assert.equal(Object.hasOwn(result, 'medicalHistory'), false)
    assert.equal(Object.hasOwn(result, 'phone'), false)
    assert.equal(mocks.record.status, 'USED')
    assert.equal(mocks.findOneAndUpdateCalls, 2, 'both scans contend on an atomic ACTIVE-only update')
    assert.deepEqual(mocks.audits.map(({ action }) => action), ['REFERRAL_VIEWED', 'REFERRAL_USED'])
    assert.equal(Object.hasOwn(mocks.audits[0], 'reason'), false)
    await assert.rejects(verifyReferralToken(token), /Referral invalid or expired/)
  } finally {
    mocks.restore()
  }
})

test('invalid, malformed, and guessed tokens receive the same generic rejection', async () => {
  const mocks = setupMocks()
  try {
    await assert.rejects(verifyReferralToken('P1024'), /Referral invalid or expired/)
    await assert.rejects(verifyReferralToken(`REF-${'b'.repeat(64)}`), /Referral invalid or expired/)
    assert.equal(mocks.findOneAndUpdateCalls, 0)
  } finally {
    mocks.restore()
  }
})

test('ASHA QR retrieval rejects a worker who does not own or share the referral patient', async () => {
  const mocks = setupMocks({ ashaOwnsReferral: false })
  try {
    await assert.rejects(
      getAshaReferralQr(REFERRAL_ID, ASHA_ID, 'http://localhost:5173'),
      /Referral invalid or expired/,
    )
    assert.equal(mocks.audits.length, 0)
  } finally {
    mocks.restore()
  }
})

test('expired referrals transition to EXPIRED and are audited', async () => {
  const mocks = setupMocks({ expiresAt: new Date(Date.now() - 60_000) })
  const token = `REF-${'c'.repeat(64)}`
  mocks.record.tokenHash = createHash('sha256').update(token).digest('hex')
  try {
    await assert.rejects(verifyReferralToken(token), /Referral invalid or expired/)
    assert.equal(mocks.record.status, 'EXPIRED')
    assert.deepEqual(mocks.audits.map(({ action }) => action), ['REFERRAL_EXPIRED'])
  } finally {
    mocks.restore()
  }
})

test('doctor revocation audits the change and makes an issued QR unusable', async () => {
  const mocks = setupMocks()
  const token = `REF-${'d'.repeat(64)}`
  mocks.record.tokenHash = createHash('sha256').update(token).digest('hex')
  try {
    const result = await revokeDoctorReferral({ patientId: PATIENT_ID, referralId: REFERRAL_ID, doctorId: DOCTOR_ID })
    assert.equal(result.status, 'REVOKED')
    assert.equal(mocks.audits[0].action, 'REFERRAL_REVOKED')
    await assert.rejects(verifyReferralToken(token), /Referral invalid or expired/)
    assert.equal(mocks.findOneAndUpdateCalls, 1)
  } finally {
    mocks.restore()
  }
})

test('verification rate limiter blocks repeated token guesses from one IP', () => {
  let now = 0
  const limiter = createReferralRateLimiter({ windowMs: 1000, maxRequests: 2, now: () => now })
  const request = { ip: '192.0.2.10' }
  const allowedResponse = { status() { return this }, json() { throw new Error('unexpected block') } }
  let nextCalls = 0
  limiter(request, allowedResponse, () => { nextCalls += 1 })
  limiter(request, allowedResponse, () => { nextCalls += 1 })
  let statusCode
  let body
  limiter(request, { status(code) { statusCode = code; return this }, json(value) { body = value; return this } }, () => { nextCalls += 1 })
  assert.equal(nextCalls, 2)
  assert.equal(statusCode, 429)
  assert.equal(body.code, 'REFERRAL_VERIFY_RATE_LIMITED')
  now = 1000
  limiter(request, allowedResponse, () => { nextCalls += 1 })
  assert.equal(nextCalls, 3)
})
