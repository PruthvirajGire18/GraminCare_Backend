import assert from 'node:assert/strict'
import { once } from 'node:events'
import test from 'node:test'
import app from '../src/app.js'
import jwt from 'jsonwebtoken'
import { env } from '../src/config/env.js'
import User from '../src/models/User.js'

test('mounted auth and health routes enforce unauthenticated access rules', async () => {
  const server = app.listen(0)
  await once(server, 'listening')
  const address = server.address()
  const baseUrl = `http://127.0.0.1:${address.port}`

  try {
    const preflightResponse = await fetch(`${baseUrl}/api/auth/login`, {
      method: 'OPTIONS',
      headers: {
        Origin: 'http://localhost:5174',
        'Access-Control-Request-Method': 'POST',
        'Access-Control-Request-Headers': 'content-type',
      },
    })
    assert.equal(preflightResponse.status, 204)
    assert.equal(preflightResponse.headers.get('access-control-allow-origin'), 'http://localhost:5174')
    assert.equal(preflightResponse.headers.get('access-control-allow-credentials'), 'true')

    const healthResponse = await fetch(`${baseUrl}/api/health`)
    assert.equal(healthResponse.status, 200)
    assert.deepEqual(await healthResponse.json(), {
      success: true,
      message: 'FieldSync API is running',
    })

    const currentUserResponse = await fetch(`${baseUrl}/api/auth/me`)
    assert.equal(currentUserResponse.status, 401)
    assert.equal((await currentUserResponse.json()).code, 'AUTH_REQUIRED')

    const adminUsersResponse = await fetch(`${baseUrl}/api/admin/users`)
    assert.equal(adminUsersResponse.status, 401)

    const ashaDashboardResponse = await fetch(`${baseUrl}/api/asha/dashboard`)
    assert.equal(ashaDashboardResponse.status, 401)
    const ashaPatientsResponse = await fetch(`${baseUrl}/api/asha/patients`)
    assert.equal(ashaPatientsResponse.status, 401)
    const pendingConflictsResponse = await fetch(`${baseUrl}/api/conflicts`)
    assert.equal(pendingConflictsResponse.status, 401)
    const doctorAssessmentsResponse = await fetch(`${baseUrl}/api/doctor/assessments`)
    assert.equal(doctorAssessmentsResponse.status, 401)
    const takeCaseResponse = await fetch(`${baseUrl}/api/doctor/cases/507f1f77bcf86cd799439011/take`, { method: 'POST' })
    assert.equal(takeCaseResponse.status, 401)

    const publicReferralVerification = await fetch(`${baseUrl}/api/referrals/verify`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: 'invalid-token' }),
    })
    assert.equal(publicReferralVerification.status, 404)
    assert.deepEqual(await publicReferralVerification.json(), {
      success: false,
      message: 'Referral invalid or expired.',
      code: 'REFERRAL_INVALID',
    })

    const publicAdminRegistration = await fetch(`${baseUrl}/api/auth/register`, {
      method: 'POST',
      headers: { Origin: 'http://localhost:5174', 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: 'Example Administrator',
        email: 'admin@example.test',
        password: 'example-password-123',
        role: 'ADMIN',
      }),
    })
    assert.equal(publicAdminRegistration.status, 400)
    assert.equal(publicAdminRegistration.headers.get('access-control-allow-origin'), 'http://localhost:5174')

    const disallowedOriginResponse = await fetch(`${baseUrl}/api/auth/register`, {
      method: 'POST',
      headers: { Origin: 'https://malicious.example.test', 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    })
    assert.equal(disallowedOriginResponse.status, 403)

    const logoutResponse = await fetch(`${baseUrl}/api/auth/logout`, { method: 'POST' })
    assert.equal(logoutResponse.status, 200)
    const clearedCookie = logoutResponse.headers.get('set-cookie')
    assert.match(clearedCookie, /fieldsync_session=;.*HttpOnly/i)
    assert.match(clearedCookie, /Expires=Thu, 01 Jan 1970/i)
  } finally {
    server.close()
    await once(server, 'close')
  }
})

test('role guards block cross-role API actions while keeping referral verification public', async () => {
  const previousFindById = User.findById
  const previousSecret = env.jwtSecret
  env.jwtSecret = 'api-test-signing-key-with-at-least-32-characters'
  const users = new Map([
    ['507f1f77bcf86cd799439011', { role: 'ASHA_WORKER' }],
    ['507f191e810c19729de860ea', { role: 'DOCTOR' }],
    ['507f191e810c19729de860eb', { role: 'ADMIN' }],
  ])
  User.findById = async (id) => ({
    _id: { toString: () => id },
    ...users.get(id),
    status: 'APPROVED',
    tokenVersion: 0,
  })
  const tokenFor = (id) => jwt.sign({ sub: id, ver: 0 }, env.jwtSecret, {
    algorithm: 'HS256', expiresIn: '1h', issuer: 'fieldsync-api', audience: 'fieldsync-web',
  })
  const server = app.listen(0)
  await once(server, 'listening')
  const baseUrl = `http://127.0.0.1:${server.address().port}`
  const patientId = '507f1f77bcf86cd799439012'
  const roleRequests = [
    ['ASHA_WORKER', 'POST', `/api/doctor/cases/${patientId}/take`],
    ['ASHA_WORKER', 'POST', `/api/doctor/cases/${patientId}/consultations`],
    ['ASHA_WORKER', 'POST', `/api/doctor/cases/${patientId}/prescriptions`],
    ['ASHA_WORKER', 'POST', `/api/doctor/cases/${patientId}/referrals`],
    ['ASHA_WORKER', 'GET', '/api/conflicts'],
    ['DOCTOR', 'GET', '/api/admin/users'],
    ['ADMIN', 'GET', '/api/doctor/cases'],
    ['ADMIN', 'GET', '/api/asha/patients'],
  ]

  try {
    for (const [role, method, path] of roleRequests) {
      const userId = [...users].find(([, user]) => user.role === role)[0]
      const response = await fetch(`${baseUrl}${path}`, {
        method,
        headers: { Cookie: `fieldsync_session=${tokenFor(userId)}`, 'Content-Type': 'application/json' },
        ...(method === 'POST' ? { body: '{}' } : {}),
      })
      assert.equal(response.status, 403, `${role} should be forbidden from ${method} ${path}`)
      assert.equal((await response.json()).code, 'ROLE_FORBIDDEN')
    }

    const publicReferralVerification = await fetch(`${baseUrl}/api/referrals/verify`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token: 'invalid-token' }),
    })
    assert.equal(publicReferralVerification.status, 404, 'QR verification is intentionally public and token-authorized')
  } finally {
    User.findById = previousFindById
    env.jwtSecret = previousSecret
    server.close()
    await once(server, 'close')
  }
})

test('API rejects Mongo operator keys and oversized JSON with safe responses', async () => {
  const server = app.listen(0)
  await once(server, 'listening')
  const baseUrl = `http://127.0.0.1:${server.address().port}`
  try {
    const operatorResponse = await fetch(`${baseUrl}/api/auth/register`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ '$where': 'true' }),
    })
    assert.equal(operatorResponse.status, 400)
    assert.equal((await operatorResponse.json()).code, 'UNSAFE_REQUEST_FIELDS')

    const queryOperatorResponse = await fetch(`${baseUrl}/api/asha/patients?%24where=true`)
    assert.equal(queryOperatorResponse.status, 400)
    assert.equal((await queryOperatorResponse.json()).code, 'UNSAFE_REQUEST_FIELDS')

    const oversizedResponse = await fetch(`${baseUrl}/api/auth/register`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ value: 'x'.repeat(101 * 1024) }),
    })
    assert.equal(oversizedResponse.status, 413)
    assert.deepEqual(await oversizedResponse.json(), { success: false, message: 'Request body is too large' })
  } finally {
    server.close()
    await once(server, 'close')
  }
})

test('login endpoint rate-limits repeated attempts from one client IP', async () => {
  const server = app.listen(0)
  await once(server, 'listening')
  const baseUrl = `http://127.0.0.1:${server.address().port}`
  try {
    const statuses = []
    for (let attempt = 0; attempt < 11; attempt += 1) {
      const response = await fetch(`${baseUrl}/api/auth/login`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}',
      })
      statuses.push(response.status)
      if (attempt === 10) {
        assert.equal(response.headers.get('retry-after') !== null, true)
        assert.equal((await response.json()).code, 'LOGIN_RATE_LIMITED')
      } else {
        await response.json()
      }
    }
    assert.deepEqual(statuses, [...Array(10).fill(400), 429])
  } finally {
    server.close()
    await once(server, 'close')
  }
})
