import assert from 'node:assert/strict'
import { once } from 'node:events'
import test from 'node:test'
import app from '../src/app.js'

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
