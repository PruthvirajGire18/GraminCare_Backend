import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto'
import mongoose from 'mongoose'
import AuditLog from '../models/ReferralAudit.js'
import Notification from '../models/Notification.js'
import Patient from '../models/Patient.js'
import Referral from '../models/Referral.js'
import { env } from '../config/env.js'
import ApiError from '../utils/ApiError.js'
import { notifyReferralGenerated, resolveReferralNotifications } from './notification.service.js'

const REFERRAL_TOKEN_PATTERN = /^REF-[a-f\d]{64}$/i
const REFERRAL_TTL_MS = 7 * 24 * 60 * 60 * 1000

function referralToken() {
  return `REF-${randomBytes(32).toString('hex')}`
}

function tokenHash(token) {
  const normalizedToken = `REF-${token.slice(4).toLowerCase()}`
  return createHash('sha256').update(normalizedToken).digest('hex')
}

function encryptionKey() {
  if (!env.jwtSecret || env.jwtSecret.length < 32) throw new Error('Referral token encryption is unavailable')
  return createHash('sha256').update(`FieldSync/referral-token/v1:${env.jwtSecret}`).digest()
}

function encryptToken(token) {
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', encryptionKey(), iv)
  const ciphertext = Buffer.concat([cipher.update(token, 'utf8'), cipher.final()])
  return {
    tokenCiphertext: ciphertext.toString('base64url'),
    tokenIv: iv.toString('base64url'),
    tokenTag: cipher.getAuthTag().toString('base64url'),
  }
}

function decryptToken(referral) {
  const decipher = createDecipheriv(
    'aes-256-gcm',
    encryptionKey(),
    Buffer.from(referral.tokenIv, 'base64url'),
  )
  decipher.setAuthTag(Buffer.from(referral.tokenTag, 'base64url'))
  return Buffer.concat([
    decipher.update(Buffer.from(referral.tokenCiphertext, 'base64url')),
    decipher.final(),
  ]).toString('utf8')
}

function patientCode(patientId) {
  return `P${patientId.toString().slice(-4).toUpperCase()}`
}

function invalidReferral() {
  return new ApiError(404, 'Referral invalid or expired.', 'REFERRAL_INVALID')
}

function modified(result) {
  return Boolean(result?.modifiedCount ?? result?.nModified ?? result?.matchedCount ?? result?.n ?? 0)
}

export async function recordReferralAudit({ referral, action, actor = null, actorRole = null }) {
  await AuditLog.create({
    referral: referral._id,
    patient: referral.patient,
    actor,
    actorRole,
    action,
    timestamp: new Date(),
  })
}

async function expireOneReferral(referral, actor = null, actorRole = null) {
  const now = new Date()
  if (referral.status !== 'ACTIVE' || !referral.expiresAt || referral.expiresAt > now) return false
  const result = await Referral.updateOne(
    { _id: referral._id, status: 'ACTIVE', expiresAt: { $lte: now } },
    { $set: { status: 'EXPIRED' } },
  )
  if (!modified(result)) return false
  referral.status = 'EXPIRED'
  await recordReferralAudit({ referral, action: 'REFERRAL_EXPIRED', actor, actorRole })
  await resolveReferralNotifications(referral._id)
  return true
}

export async function expireReferralRecords(referrals, actor = null, actorRole = null) {
  for (const referral of referrals || []) await expireOneReferral(referral, actor, actorRole)
  return referrals || []
}

export async function issueReferral({ patient, consultation, doctorId, reason, priority, destination }) {
  const token = referralToken()
  const expiresAt = new Date(Date.now() + REFERRAL_TTL_MS)
  const referral = await Referral.create({
    patient: patient._id,
    consultation: consultation._id,
    doctor: doctorId,
    ashaWorker: patient.createdBy,
    reason,
    priority,
    destination,
    tokenHash: tokenHash(token),
    ...encryptToken(token),
    expiresAt,
  })
  await recordReferralAudit({ referral, action: 'REFERRAL_CREATED', actor: doctorId, actorRole: 'DOCTOR' })
  await notifyReferralGenerated(referral, patient)
  return {
    referral: {
      id: referral._id,
      status: referral.status,
      reason: referral.reason,
      priority: referral.priority,
      destination: referral.destination,
      createdAt: referral.createdAt,
      expiresAt: referral.expiresAt,
    },
  }
}

export async function listAshaReferralSummaries(patientIds) {
  if (!patientIds?.length) return []
  const referrals = await Referral.find({ patient: { $in: patientIds }, status: 'ACTIVE' })
    .select('patient priority destination createdAt expiresAt status')
    .sort({ createdAt: -1 })
    .limit(100)
    .lean()
  await expireReferralRecords(referrals)
  return referrals
    .filter((referral) => referral.status === 'ACTIVE')
    .map((referral) => ({
      id: referral._id,
      patientId: referral.patient,
      patientCode: patientCode(referral.patient),
      priority: referral.priority,
      destination: referral.destination,
      status: referral.status,
      createdAt: referral.createdAt,
      expiresAt: referral.expiresAt,
    }))
}

async function rotateReferralToken(referral) {
  const token = referralToken()
  const encrypted = encryptToken(token)
  const result = await Referral.updateOne(
    { _id: referral._id, status: 'ACTIVE', expiresAt: { $gt: new Date() } },
    { $set: { tokenHash: tokenHash(token), ...encrypted } },
  )
  if (!modified(result)) throw invalidReferral()
  Object.assign(referral, encrypted)
  return token
}

export async function getAshaReferralQr(referralId, ashaWorkerId) {
  if (!mongoose.isValidObjectId(referralId)) throw invalidReferral()
  let referral = await Referral.findOne({ _id: referralId }).select('+tokenCiphertext +tokenIv +tokenTag')
  if (!referral) throw invalidReferral()
  const patient = await Patient.findOne({
    _id: referral.patient,
    status: 'ACTIVE',
    $or: [{ createdBy: ashaWorkerId }, { ashaWorkers: ashaWorkerId }],
  }).select('_id')
  if (!patient) throw invalidReferral()
  if (await expireOneReferral(referral, ashaWorkerId, 'ASHA_WORKER')) throw invalidReferral()
  if (referral.status !== 'ACTIVE') throw invalidReferral()

  let token
  if (!referral.tokenCiphertext || !referral.tokenIv || !referral.tokenTag) {
    token = await rotateReferralToken(referral)
  } else {
    try {
      token = decryptToken(referral)
    } catch {
      token = await rotateReferralToken(referral)
    }
  }
  await recordReferralAudit({ referral, action: 'REFERRAL_VIEWED', actor: ashaWorkerId, actorRole: 'ASHA_WORKER' })
  return { verificationUrl: `/doctor#${token}`, expiresAt: referral.expiresAt }
}

export async function consumeReferralTokenForDoctor(token, doctorId) {
  if (typeof token !== 'string' || !REFERRAL_TOKEN_PATTERN.test(token)) throw invalidReferral()
  const referral = await Referral.findOne({ tokenHash: tokenHash(token) })
  if (!referral) throw invalidReferral()
  if (await expireOneReferral(referral, doctorId, 'DOCTOR')) throw invalidReferral()
  if (referral.status !== 'ACTIVE' || referral.expiresAt <= new Date()) throw invalidReferral()

  const patient = await Patient.findOne({ _id: referral.patient, status: 'ACTIVE' }).select('_id')
  if (!patient) throw invalidReferral()

  const usedReferral = await Referral.findOneAndUpdate(
    { _id: referral._id, status: 'ACTIVE', expiresAt: { $gt: new Date() } },
    { $set: { status: 'USED' } },
    { returnDocument: 'after' },
  ).select('patient')
  if (!usedReferral) {
    await expireOneReferral(referral, doctorId, 'DOCTOR')
    throw invalidReferral()
  }

  await recordReferralAudit({ referral: usedReferral, action: 'REFERRAL_ACCESSED', actor: doctorId, actorRole: 'DOCTOR' })
  await recordReferralAudit({ referral: usedReferral, action: 'REFERRAL_USED', actor: doctorId, actorRole: 'DOCTOR' })
  await resolveReferralNotifications(usedReferral._id)
  return usedReferral.patient
}

export async function verifyReferralToken(token) {
  if (typeof token !== 'string' || !REFERRAL_TOKEN_PATTERN.test(token)) throw invalidReferral()
  const referral = await Referral.findOne({ tokenHash: tokenHash(token) })
    .populate({ path: 'doctor', select: 'name' })
  if (!referral) throw invalidReferral()
  if (await expireOneReferral(referral)) throw invalidReferral()
  if (referral.status !== 'ACTIVE' || referral.expiresAt <= new Date()) throw invalidReferral()

  const usedReferral = await Referral.findOneAndUpdate(
    { _id: referral._id, status: 'ACTIVE', expiresAt: { $gt: new Date() } },
    { $set: { status: 'USED' } },
    { returnDocument: 'after' },
  ).select('patient doctor reason priority destination createdAt expiresAt status')
  if (!usedReferral) {
    await expireOneReferral(referral)
    throw invalidReferral()
  }

  await recordReferralAudit({ referral: usedReferral, action: 'REFERRAL_ACCESSED' })
  await recordReferralAudit({ referral: usedReferral, action: 'REFERRAL_USED' })
  await resolveReferralNotifications(usedReferral._id)

  return {
    patientReference: patientCode(usedReferral.patient),
    doctorName: referral.doctor?.name || 'Doctor',
    reason: usedReferral.reason,
    priority: usedReferral.priority,
    destination: usedReferral.destination,
    createdAt: usedReferral.createdAt,
    expiresAt: usedReferral.expiresAt,
    status: 'USED',
  }
}

export async function revokeDoctorReferral({ patientId, referralId, doctorId }) {
  if (!mongoose.isValidObjectId(referralId)) throw new ApiError(404, 'Referral not found')
  const referral = await Referral.findOne({ _id: referralId, patient: patientId, doctor: doctorId })
  if (!referral) throw new ApiError(404, 'Referral not found')
  if (await expireOneReferral(referral, doctorId, 'DOCTOR')) throw new ApiError(409, 'Expired referrals cannot be revoked')
  if (referral.status !== 'ACTIVE') throw new ApiError(409, 'Only active referrals can be revoked')
  const revoked = await Referral.findOneAndUpdate(
    { _id: referral._id, patient: patientId, doctor: doctorId, status: 'ACTIVE', expiresAt: { $gt: new Date() } },
    { $set: { status: 'REVOKED' } },
    { returnDocument: 'after' },
  )
  if (!revoked) throw new ApiError(409, 'Referral status changed. Refresh and try again.')
  await recordReferralAudit({ referral: revoked, action: 'REFERRAL_REVOKED', actor: doctorId, actorRole: 'DOCTOR' })
  await resolveReferralNotifications(revoked._id)
  return { id: revoked._id, status: revoked.status }
}

export { REFERRAL_TOKEN_PATTERN }
