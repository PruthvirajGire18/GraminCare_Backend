import assert from 'node:assert/strict'
import bcrypt from 'bcrypt'
import test from 'node:test'
import jwt from 'jsonwebtoken'
import { env } from '../src/config/env.js'
import { requireAuth } from '../src/middleware/auth.middleware.js'
import { isAllowedOrigin } from '../src/middleware/origin.middleware.js'
import { requireRole } from '../src/middleware/role.middleware.js'
import User, { USER_ROLES, USER_STATUSES } from '../src/models/User.js'
import { loginUser, registerUser } from '../src/services/auth.service.js'
import { AUTH_COOKIE_NAME } from '../src/utils/authCookie.js'

test('the model exposes exactly the three FieldSync roles and supported statuses', () => {
  assert.deepEqual(USER_ROLES, ['ADMIN', 'ASHA_WORKER', 'DOCTOR'])
  assert.deepEqual(USER_STATUSES, ['PENDING', 'APPROVED', 'REJECTED', 'INACTIVE'])
  assert.deepEqual(User.schema.path('role').enumValues, USER_ROLES)
  assert.equal(User.schema.path('status').defaultValue, 'PENDING')
})

test('public signup rejects ADMIN before writing to the database', async () => {
  await assert.rejects(
    registerUser({
      name: 'Example Administrator',
      email: 'admin@example.test',
      password: 'example-password-123',
      role: 'ADMIN',
    }),
    (error) => error.statusCode === 400 && error.message.includes('ASHA_WORKER or DOCTOR'),
  )
})

test('pending registrations cannot log in even with a correct password', async () => {
  const previousFindOne = User.findOne
  const passwordHash = await bcrypt.hash('example-password-123', 4)
  User.findOne = () => ({ select: async () => ({ passwordHash, status: 'PENDING' }) })

  try {
    await assert.rejects(
      loginUser({ email: 'asha@example.test', password: 'example-password-123' }),
      (error) => error.statusCode === 403 && error.code === 'ACCOUNT_PENDING',
    )
  } finally {
    User.findOne = previousFindOne
  }
})

test('authentication middleware verifies the cookie and loads the current approved user', async () => {
  const previousFindById = User.findById
  const previousSecret = env.jwtSecret
  env.jwtSecret = 'test-only-signing-key-with-at-least-32-characters'
  User.findById = async (id) => ({
    _id: { toString: () => id },
    name: 'Example Doctor',
    email: 'doctor@example.test',
    role: 'DOCTOR',
    status: 'APPROVED',
  })
  const token = jwt.sign({ sub: 'approved-user-id' }, env.jwtSecret, { expiresIn: '1h' })
  const request = { cookies: { [AUTH_COOKIE_NAME]: token } }
  let receivedError

  try {
    await requireAuth(request, {}, (error) => { receivedError = error })
    assert.equal(receivedError, undefined)
    assert.equal(request.user.role, 'DOCTOR')
    assert.equal(request.user.status, 'APPROVED')
  } finally {
    User.findById = previousFindById
    env.jwtSecret = previousSecret
  }
})

test('authentication middleware denies a request without a session cookie', async () => {
  let receivedError
  await requireAuth({ cookies: {} }, {}, (error) => { receivedError = error })
  assert.equal(receivedError.statusCode, 401)
  assert.equal(receivedError.code, 'AUTH_REQUIRED')
})

test('role middleware denies ASHA_WORKER and DOCTOR from admin resources', () => {
  for (const role of ['ASHA_WORKER', 'DOCTOR']) {
    let receivedError
    requireRole('ADMIN')({ user: { role } }, {}, (error) => { receivedError = error })
    assert.equal(receivedError.statusCode, 403)
    assert.equal(receivedError.code, 'ROLE_FORBIDDEN')
  }
})

test('role middleware allows only the explicitly permitted role', () => {
  let receivedError
  let continued = false
  requireRole('DOCTOR')({ user: { role: 'DOCTOR' } }, {}, (error) => {
    receivedError = error
    continued = true
  })
  assert.equal(receivedError, undefined)
  assert.equal(continued, true)
})

test('development allows alternate localhost ports but rejects non-local origins', () => {
  assert.equal(isAllowedOrigin('http://localhost:5174'), true)
  assert.equal(isAllowedOrigin('http://127.0.0.1:4173'), true)
  assert.equal(isAllowedOrigin('https://localhost:5174'), false)
  assert.equal(isAllowedOrigin('https://localhost.example.test'), false)
})

test('production allows only the configured frontend origin', () => {
  const previousNodeEnv = env.nodeEnv
  env.nodeEnv = 'production'
  try {
    assert.equal(isAllowedOrigin(env.clientOrigin), true)
    assert.equal(isAllowedOrigin('http://localhost:5174'), false)
  } finally {
    env.nodeEnv = previousNodeEnv
  }
})
