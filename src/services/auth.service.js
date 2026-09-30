import bcrypt from 'bcrypt'
import jwt from 'jsonwebtoken'
import { env } from '../config/env.js'
import User from '../models/User.js'
import ApiError from '../utils/ApiError.js'
import { toUserDto } from '../utils/userDto.js'

const AUTH_TOKEN_TTL = '8h'
const PASSWORD_MIN_LENGTH = 10
const PASSWORD_MAX_BYTES = 72
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
const SIGNUP_ROLES = ['ASHA_WORKER', 'DOCTOR']

function normalizeEmail(email) {
  return typeof email === 'string' ? email.trim().toLowerCase() : ''
}

function validateCredentials({ name, email, password, role }) {
  if (typeof name !== 'string' || name.trim().length < 2 || name.trim().length > 100) {
    throw new ApiError(400, 'Name must be between 2 and 100 characters')
  }
  if (!EMAIL_PATTERN.test(email) || email.length > 254) {
    throw new ApiError(400, 'Enter a valid email address')
  }
  if (
    typeof password !== 'string'
    || password.length < PASSWORD_MIN_LENGTH
    || Buffer.byteLength(password, 'utf8') > PASSWORD_MAX_BYTES
  ) {
    throw new ApiError(400, 'Password must be at least 10 characters and at most 72 UTF-8 bytes')
  }
  if (!SIGNUP_ROLES.includes(role)) {
    throw new ApiError(400, 'Role must be ASHA_WORKER or DOCTOR')
  }
}

function signSession(user) {
  return jwt.sign({ sub: user._id.toString() }, env.jwtSecret, { expiresIn: AUTH_TOKEN_TTL })
}

export async function registerUser(input) {
  const email = normalizeEmail(input.email)
  validateCredentials({ ...input, email })

  const passwordHash = await bcrypt.hash(input.password, 12)
  try {
    const user = await User.create({
      name: input.name.trim(),
      email,
      passwordHash,
      role: input.role,
      status: 'PENDING',
    })
    return toUserDto(user)
  } catch (error) {
    if (error.code === 11000) {
      throw new ApiError(409, 'An account with this email already exists')
    }
    throw error
  }
}

export async function loginUser(input) {
  const email = normalizeEmail(input.email)
  if (!email || typeof input.password !== 'string') {
    throw new ApiError(400, 'Email and password are required')
  }

  const user = await User.findOne({ email }).select('+passwordHash')
  const passwordMatches = user && await bcrypt.compare(input.password, user.passwordHash)
  if (!passwordMatches) {
    throw new ApiError(401, 'Email or password is incorrect', 'INVALID_CREDENTIALS')
  }
  if (user.status !== 'APPROVED') {
    const statusErrors = {
      PENDING: ['Your account is awaiting administrator approval', 'ACCOUNT_PENDING'],
      REJECTED: ['Your registration was not approved', 'ACCOUNT_REJECTED'],
      INACTIVE: ['This account is inactive', 'ACCOUNT_INACTIVE'],
    }
    const [message, code] = statusErrors[user.status] || statusErrors.INACTIVE
    throw new ApiError(403, message, code)
  }

  return { token: signSession(user), user: toUserDto(user) }
}

export async function loadSessionUser(userId) {
  return User.findById(userId)
}
