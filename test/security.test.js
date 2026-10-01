import assert from 'node:assert/strict'
import test from 'node:test'
import jwt from 'jsonwebtoken'
import { env } from '../src/config/env.js'
import { createRateLimiter } from '../src/middleware/rateLimit.middleware.js'
import SecurityAuditEvent from '../src/models/SecurityAuditEvent.js'
import User from '../src/models/User.js'
import { changeUserStatus, rejectUser } from '../src/controllers/admin.controller.js'
import { revokeSession } from '../src/services/auth.service.js'

test('rate limiter returns a bounded retry interval and resets after its window', () => {
  let now = 0
  const limiter = createRateLimiter({ windowMs: 1000, maxRequests: 2, code: 'LIMITED', message: 'Wait', now: () => now })
  const request = { ip: '192.0.2.15' }
  const allowedResponse = { set() { return this }, status() { return this }, json() { throw new Error('unexpected rate limit') } }
  let nextCount = 0
  limiter(request, allowedResponse, () => { nextCount += 1 })
  limiter(request, allowedResponse, () => { nextCount += 1 })
  let responseBody
  let retryAfter
  limiter(request, {
    set(name, value) { if (name === 'Retry-After') retryAfter = value; return this },
    status(code) { assert.equal(code, 429); return this },
    json(body) { responseBody = body; return this },
  }, () => { nextCount += 1 })
  assert.equal(nextCount, 2)
  assert.equal(retryAfter, '1')
  assert.equal(responseBody.code, 'LIMITED')
  now = 1000
  limiter(request, allowedResponse, () => { nextCount += 1 })
  assert.equal(nextCount, 3)
})

test('logout atomically increments the user token version for session revocation', async () => {
  const previousFindOneAndUpdate = User.findOneAndUpdate
  const previousSecret = env.jwtSecret
  env.jwtSecret = 'logout-test-signing-key-with-at-least-32-characters'
  let updateFilter
  let updateDocument
  const user = { _id: '507f1f77bcf86cd799439011', role: 'DOCTOR' }
  User.findOneAndUpdate = (filter, update) => {
    updateFilter = filter
    updateDocument = update
    return { select: async () => user }
  }
  const token = jwt.sign({ sub: user._id, ver: 4 }, env.jwtSecret, {
    algorithm: 'HS256', expiresIn: '1h', issuer: 'fieldsync-api', audience: 'fieldsync-web',
  })

  try {
    assert.equal(await revokeSession(token), user)
    assert.deepEqual(updateFilter, { _id: user._id, tokenVersion: 4 })
    assert.deepEqual(updateDocument, { $inc: { tokenVersion: 1 } })
    const legacyToken = jwt.sign({ sub: user._id, ver: 0 }, env.jwtSecret, {
      algorithm: 'HS256', expiresIn: '1h', issuer: 'fieldsync-api', audience: 'fieldsync-web',
    })
    await revokeSession(legacyToken)
    assert.deepEqual(updateFilter, { _id: user._id, $or: [{ tokenVersion: 0 }, { tokenVersion: { $exists: false } }] })
    assert.equal(await revokeSession('malformed-token'), null)
  } finally {
    User.findOneAndUpdate = previousFindOneAndUpdate
    env.jwtSecret = previousSecret
  }
})

test('security audit schema records only minimal action and identifier fields', () => {
  const paths = Object.keys(SecurityAuditEvent.schema.paths)
  assert.deepEqual(paths.sort(), ['_id', 'action', 'actor', 'actorRole', 'occurredAt', 'resourceId', 'resourceType'].sort())
  assert.deepEqual(SecurityAuditEvent.schema.path('action').enumValues.includes('PRESCRIPTION_CREATED'), true)
  for (const action of ['USER_REJECTED', 'USER_STATUS_CHANGED', 'PATIENT_SHARED', 'PATIENT_ARCHIVED']) {
    assert.equal(SecurityAuditEvent.schema.path('action').enumValues.includes(action), true)
  }
  assert.equal(paths.some((path) => /password|secret|email|symptom|vital|medicine/i.test(path)), false)
})

test('account rejection and status changes emit distinct audit events', async () => {
  const previousFindById = User.findById
  const previousAuditCreate = SecurityAuditEvent.create
  const auditEvents = []
  const userId = '507f1f77bcf86cd799439011'
  const actorId = '507f1f77bcf86cd799439012'
  User.findById = async () => ({
    _id: userId,
    name: 'Worker',
    email: 'worker@example.test',
    role: 'ASHA_WORKER',
    status: 'PENDING',
    tokenVersion: 0,
    createdAt: new Date(),
    async save() {},
  })
  SecurityAuditEvent.create = async (event) => { auditEvents.push(event); return event }

  const response = { status() { return this }, json() { return this } }
  const request = { params: { id: userId }, body: { status: 'INACTIVE' }, user: { _id: actorId, role: 'ADMIN' } }
  try {
    await rejectUser(request, response)
    await changeUserStatus(request, response)
    assert.deepEqual(auditEvents.map(({ action }) => action), ['USER_REJECTED', 'USER_STATUS_CHANGED'])
    assert.deepEqual(auditEvents.map(({ resourceId }) => resourceId), [userId, userId])
  } finally {
    User.findById = previousFindById
    SecurityAuditEvent.create = previousAuditCreate
  }
})
