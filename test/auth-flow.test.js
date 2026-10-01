import assert from 'node:assert/strict'
import bcrypt from 'bcrypt'
import test from 'node:test'
import jwt from 'jsonwebtoken'
import { env } from '../src/config/env.js'
import User from '../src/models/User.js'
import { loginUser, registerUser } from '../src/services/auth.service.js'
import { decideRegistration } from '../src/services/admin.service.js'

const TEST_PASSWORD = 'example-password-123'
const TEST_JWT_SECRET = 'unit-test-only-secret-with-at-least-32-characters'
const USER_ID = '507f1f77bcf86cd799439011'

for (const role of ['ASHA_WORKER', 'DOCTOR']) {
  test(`${role} signup stores a pending account with a bcrypt password hash`, async () => {
    const previousCreate = User.create
    let createdDocument
    User.create = async (document) => {
      createdDocument = document
      return {
        ...document,
        _id: { toString: () => USER_ID },
        createdAt: new Date('2026-01-01T00:00:00.000Z'),
      }
    }

    try {
      const user = await registerUser({
        name: 'Example Care Worker',
        email: `${role.toLowerCase()}@example.test`,
        password: TEST_PASSWORD,
        role,
      })
      assert.equal(user.role, role)
      assert.equal(user.status, 'PENDING')
      assert.notEqual(createdDocument.passwordHash, TEST_PASSWORD)
      assert.equal(await bcrypt.compare(TEST_PASSWORD, createdDocument.passwordHash), true)
      assert.equal(Object.hasOwn(user, 'passwordHash'), false)
    } finally {
      User.create = previousCreate
    }
  })
}

test('approved login returns a JWT for the HttpOnly cookie and no password hash', async () => {
  const previousFindOne = User.findOne
  const previousSecret = env.jwtSecret
  const passwordHash = await bcrypt.hash(TEST_PASSWORD, 4)
  env.jwtSecret = TEST_JWT_SECRET
  User.findOne = () => ({
    select: async () => ({
      _id: { toString: () => USER_ID },
      name: 'Example Doctor',
      email: 'doctor@example.test',
      role: 'DOCTOR',
      status: 'APPROVED',
      passwordHash,
      createdAt: new Date('2026-01-01T00:00:00.000Z'),
    }),
  })

  try {
    const result = await loginUser({ email: 'doctor@example.test', password: TEST_PASSWORD })
    const tokenPayload = jwt.verify(result.token, TEST_JWT_SECRET, {
      algorithms: ['HS256'], issuer: 'fieldsync-api', audience: 'fieldsync-web',
    })
    assert.equal(tokenPayload.sub, USER_ID)
    assert.equal(tokenPayload.ver, 0)
    assert.ok(tokenPayload.exp - tokenPayload.iat <= 8 * 60 * 60)
    assert.equal(result.user.role, 'DOCTOR')
    assert.equal(Object.hasOwn(result.user, 'passwordHash'), false)
  } finally {
    User.findOne = previousFindOne
    env.jwtSecret = previousSecret
  }
})

test('admin approval transitions only a pending non-admin registration', async () => {
  const previousFindById = User.findById
  const pendingUser = {
    _id: { toString: () => USER_ID },
    name: 'Example ASHA Worker',
    email: 'asha@example.test',
    role: 'ASHA_WORKER',
    status: 'PENDING',
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    async save() {},
  }
  User.findById = async () => pendingUser

  try {
    const approved = await decideRegistration(USER_ID, 'APPROVED')
    assert.equal(approved.status, 'APPROVED')
    await assert.rejects(decideRegistration(USER_ID, 'REJECTED'), (error) => error.statusCode === 409)
  } finally {
    User.findById = previousFindById
  }
})
