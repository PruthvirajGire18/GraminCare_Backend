import mongoose from 'mongoose'
import ASHAVisit from '../models/ASHAVisit.js'
import AuditLog from '../models/AuditLog.js'
import ConflictRecord from '../models/ConflictRecord.js'
import Patient from '../models/Patient.js'
import { resetAssessmentFields } from './aiRiskQueue.service.js'
import ApiError from '../utils/ApiError.js'

const PATIENT_FIELDS = new Set([
  'fullName', 'dateOfBirth', 'gender', 'phone',
  'address.village', 'address.district', 'address.state', 'address.details',
])
const VISIT_FIELDS = new Set([
  'symptoms.chiefComplaint', 'symptoms.details', 'symptoms.durationDays', 'medicalHistory', 'allergies',
  'currentMedicines', 'observations', 'followUp.date',
  'vitals.temperatureC', 'vitals.heartRateBpm', 'vitals.respiratoryRatePerMinute',
  'vitals.systolicMmHg', 'vitals.diastolicMmHg', 'vitals.oxygenSaturationPercent',
  'vitals.weightKg', 'vitals.heightCm',
])
const ASSESSMENT_FIELDS = new Set([
  'symptoms.chiefComplaint', 'symptoms.details', 'symptoms.durationDays', 'medicalHistory',
  'allergies', 'currentMedicines', 'observations', 'vitals.temperatureC',
  'vitals.heartRateBpm', 'vitals.respiratoryRatePerMinute', 'vitals.systolicMmHg',
  'vitals.diastolicMmHg', 'vitals.oxygenSaturationPercent',
])
const ADDRESS_FIELDS = ['village', 'district', 'state', 'details']
const ALLOWED_RESOLUTIONS = ['KEEP_CURRENT', 'USE_INCOMING', 'CUSTOM']
const AUDIT_EVENT_KEYS = {
  CONFLICT_DETECTED: 'detected',
  CONFLICT_REVIEWED: 'reviewed',
  CONFLICT_RESOLVED: 'resolved',
}

async function appendConflictAuditEvent({ conflict, actorId, action, resolution = null }) {
  const eventKey = AUDIT_EVENT_KEYS[action]
  if (!eventKey) throw new Error(`Unsupported conflict audit action: ${action}`)
  const timestamp = new Date()
  const event = {
    actor: actorId,
    action,
    resource: `${conflict.recordType}_FIELD`,
    resourceId: conflict.recordId,
    timestamp,
    resolution,
  }
  try {
    await AuditLog.updateOne(
      { conflictId: conflict._id, [`events.${eventKey}`]: { $exists: false } },
      {
        $set: {
          actor: actorId,
          action,
          patientId: conflict.patientId,
          recordType: conflict.recordType,
          recordId: conflict.recordId,
          resolution,
          [`events.${eventKey}`]: event,
        },
        $setOnInsert: { conflictId: conflict._id },
      },
      { upsert: true },
    )
  } catch (error) {
    // A concurrent retry can race the unique conflictId index after an event is recorded.
    if (error.code !== 11000) throw error
  }
}

function canonical(value) {
  if (value instanceof Date) return value.toISOString()
  if (value === undefined) return null
  if (Array.isArray(value)) return value.map(canonical)
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]))
  }
  return value
}

function sameValue(left, right) {
  return JSON.stringify(canonical(left)) === JSON.stringify(canonical(right))
}

function flattenChanges(recordType, changes) {
  if (!changes || typeof changes !== 'object' || Array.isArray(changes)) {
    throw new ApiError(400, 'Changes must be an object')
  }
  const flattened = {}
  for (const [key, value] of Object.entries(changes)) {
    if (recordType === 'PATIENT' && key === 'address') {
      if (!value || typeof value !== 'object' || Array.isArray(value)) throw new ApiError(400, 'Address changes must be an object')
      for (const field of ADDRESS_FIELDS) {
        if (Object.hasOwn(value, field)) flattened[`address.${field}`] = value[field]
      }
    } else if ((recordType === 'PATIENT' && PATIENT_FIELDS.has(key)) || (recordType === 'ASHA_VISIT' && VISIT_FIELDS.has(key))) {
      flattened[key] = value
    } else if (recordType === 'ASHA_VISIT' && ['symptoms', 'vitals', 'followUp'].includes(key)) {
      const allowedSubfields = key === 'symptoms'
        ? ['chiefComplaint', 'details', 'durationDays']
        : key === 'vitals'
          ? [...VISIT_FIELDS].filter((field) => field.startsWith('vitals.')).map((field) => field.slice(7))
          : ['date']
      if (!value || typeof value !== 'object' || Array.isArray(value)) throw new ApiError(400, `${key} changes must be an object`)
      for (const field of allowedSubfields) {
        if (Object.hasOwn(value, field)) flattened[`${key}.${field}`] = value[field]
      }
    } else {
      throw new ApiError(400, `Field cannot be updated: ${key}`)
    }
  }
  if (Object.keys(flattened).length === 0) throw new ApiError(400, 'Provide at least one field change')
  return flattened
}

function getPathValue(record, path) {
  return path.split('.').reduce((value, segment) => value?.[segment], record)
}

function setPathValue(record, path, value) {
  record.set(path, value)
}

function validateBase({ baseVersion, baseValues, fields, clientOperationId }) {
  if (!Number.isInteger(baseVersion) || baseVersion < 1) {
    throw new ApiError(400, 'baseVersion must be a positive integer')
  }
  if (!baseValues || typeof baseValues !== 'object' || Array.isArray(baseValues)) {
    throw new ApiError(400, 'baseValues must contain the values originally read for each changed field')
  }
  for (const field of fields) {
    if (!Object.hasOwn(baseValues, field)) throw new ApiError(400, `baseValues is missing ${field}`)
  }
  if (typeof clientOperationId !== 'string' || clientOperationId.length < 16 || clientOperationId.length > 128 || !/^[A-Za-z0-9_-]+$/.test(clientOperationId)) {
    throw new ApiError(400, 'A valid clientOperationId is required')
  }
}

export function planFieldMerge({ baseVersion, currentVersion, baseValues, changes, currentRecord }) {
  const safeChanges = {}
  const conflicts = []

  for (const [field, incomingValue] of Object.entries(changes)) {
    const oldValue = baseValues[field]
    const currentValue = getPathValue(currentRecord, field)
    if (sameValue(currentValue, incomingValue)) continue
    if (sameValue(currentValue, oldValue)) {
      safeChanges[field] = incomingValue
      continue
    }
    conflicts.push({ field, oldValue, incomingValue, currentValue })
  }

  return { safeChanges, conflicts }
}

function conflictDto(conflict) {
  const summarizeUser = (user) => {
    if (user && typeof user === 'object' && user.name) {
      return { id: user._id.toString(), name: user.name, role: user.role }
    }
    return user?.toString() || null
  }
  return {
    id: conflict._id.toString(),
    patientId: conflict.patientId.toString(),
    recordType: conflict.recordType,
    recordId: conflict.recordId.toString(),
    field: conflict.field,
    oldValue: conflict.oldValue,
    incomingValue: conflict.incomingValue,
    currentValue: conflict.currentValue,
    conflictingUser: summarizeUser(conflict.conflictingUser),
    currentUser: summarizeUser(conflict.currentUser),
    clientOperationId: conflict.clientOperationId,
    baseVersion: conflict.baseVersion,
    currentVersion: conflict.currentVersion,
    status: conflict.status,
    createdAt: conflict.createdAt,
    resolvedAt: conflict.resolvedAt,
    resolution: conflict.resolution,
    resolvedValue: conflict.resolvedValue,
  }
}

async function findPatientForWorker(patientId, workerId) {
  if (!mongoose.isValidObjectId(patientId)) throw new ApiError(400, 'Patient id is invalid')
  const patient = await Patient.findOne({
    _id: patientId,
    status: 'ACTIVE',
    $or: [{ createdBy: workerId }, { ashaWorkers: workerId }],
  })
  if (!patient) throw new ApiError(404, 'Patient not found')
  return patient
}

async function getRecord(recordType, recordId, patientId, workerId) {
  if (!mongoose.isValidObjectId(recordId)) throw new ApiError(400, 'Record id is invalid')
  if (recordType === 'PATIENT') return findPatientForWorker(recordId, workerId)
  const patient = await findPatientForWorker(patientId, workerId)
  const visit = await ASHAVisit.findOne({ _id: recordId, patient: patient._id })
  if (!visit) throw new ApiError(404, 'ASHA visit not found')
  return visit
}

function normalizePatientField(field, value) {
  if (field === 'fullName') {
    if (typeof value !== 'string' || value.trim().length < 2 || value.trim().length > 120) throw new ApiError(400, 'Full name must be between 2 and 120 characters')
    return value.trim()
  }
  if (field === 'gender') {
    if (!['FEMALE', 'MALE', 'OTHER', 'UNKNOWN'].includes(value)) throw new ApiError(400, 'Gender is invalid')
    return value
  }
  if (field === 'dateOfBirth') {
    if (value === null || value === '') return null
    const date = new Date(value)
    if (Number.isNaN(date.getTime()) || date > new Date()) throw new ApiError(400, 'Date of birth is invalid')
    return date
  }
  const maximum = field === 'address.details' ? 300 : field.startsWith('address.') ? 120 : 25
  if (typeof value !== 'string' || value.trim().length > maximum) throw new ApiError(400, `${field} is invalid`)
  const normalized = value.trim()
  if (field === 'phone' && normalized && !/^\+?[0-9().\s-]{5,25}$/.test(normalized)) throw new ApiError(400, 'Phone number contains invalid characters')
  return normalized
}

async function fetchOperationConflicts(recordType, recordId, clientOperationId) {
  const conflicts = await ConflictRecord.find({ recordType, recordId, clientOperationId }).sort({ createdAt: 1 }).lean()
  return conflicts.map(conflictDto)
}

export async function applyVersionedChanges({
  recordType,
  recordId,
  patientId,
  changes: rawChanges,
  baseValues,
  baseVersion,
  clientOperationId,
  userId,
}) {
  const changes = flattenChanges(recordType, rawChanges)
  validateBase({ baseVersion, baseValues, fields: Object.keys(changes), clientOperationId })
  if (recordType === 'PATIENT') {
    for (const [field, value] of Object.entries(changes)) changes[field] = normalizePatientField(field, value)
  }

  for (let attempt = 0; attempt < 4; attempt += 1) {
    const record = await getRecord(recordType, recordId, patientId, userId)
    const actualPatientId = recordType === 'PATIENT' ? record._id : record.patient
    const currentVersion = record.version
    const priorConflicts = await fetchOperationConflicts(recordType, record._id, clientOperationId)
    if (record.clientOperationId === clientOperationId) {
      return { record, conflicts: priorConflicts, mergedFields: [], duplicate: true }
    }
    if (baseVersion > record.version) throw new ApiError(409, 'Client baseVersion is newer than the current record version')

    const { safeChanges, conflicts } = planFieldMerge({
      baseVersion,
      currentVersion: record.version,
      baseValues,
      changes,
      currentRecord: record,
    })

    if (!(record.fieldUpdatedBy instanceof Map)) record.fieldUpdatedBy = new Map()
    const conflictOwners = new Map(conflicts.map((conflict) => [
      conflict.field,
      record.fieldUpdatedBy.get(conflict.field) || record.updatedBy,
    ]))
    for (const [field, value] of Object.entries(safeChanges)) {
      setPathValue(record, field, value)
      record.fieldUpdatedBy.set(field, userId)
    }
    if (Object.keys(safeChanges).length) {
      if (recordType === 'ASHA_VISIT' && Object.keys(safeChanges).some((field) => ASSESSMENT_FIELDS.has(field))) {
        for (const [path, value] of Object.entries(resetAssessmentFields())) record.set(path, value)
      }
      record.version += 1
      record.updatedBy = userId
      if (conflicts.length === 0) record.clientOperationId = clientOperationId
      try {
        await record.save()
      } catch (error) {
        if (error.name === 'VersionError' && attempt < 3) continue
        if (error.name === 'ValidationError') throw new ApiError(400, error.message)
        throw error
      }
    }

    if (conflicts.length) {
      await Promise.all(conflicts.map(async (fieldConflict) => {
        const filter = { recordType, recordId: record._id, clientOperationId, field: fieldConflict.field }
        const result = await ConflictRecord.updateOne(
          filter,
          {
            $setOnInsert: {
              patientId: actualPatientId,
              recordType,
              recordId: record._id,
              field: fieldConflict.field,
              oldValue: fieldConflict.oldValue,
              incomingValue: fieldConflict.incomingValue,
              currentValue: fieldConflict.currentValue,
              conflictingUser: userId,
              currentUser: conflictOwners.get(fieldConflict.field),
              clientOperationId,
              baseVersion,
              currentVersion: record.version,
              status: 'PENDING',
            },
          },
          { upsert: true },
        )
        if (result?.upsertedCount) {
          await appendConflictAuditEvent({
            conflict: {
              _id: result.upsertedId,
              patientId: actualPatientId,
              recordType,
              recordId: record._id,
            },
            actorId: userId,
            action: 'CONFLICT_DETECTED',
          })
        }
      }))
    } else if (!Object.keys(safeChanges).length) {
      record.clientOperationId = clientOperationId
      try {
        await record.save()
      } catch (error) {
        if (error.name === 'VersionError' && attempt < 3) continue
        if (error.name === 'ValidationError') throw new ApiError(400, error.message)
        throw error
      }
    }

    const conflictRecords = await fetchOperationConflicts(recordType, record._id, clientOperationId)
    return {
      record,
      conflicts: conflictRecords,
      mergedFields: Object.keys(safeChanges),
      duplicate: false,
    }
  }
  throw new ApiError(409, 'Record changed repeatedly; reload before retrying')
}

export async function listPendingConflicts() {
  const conflicts = await ConflictRecord.find({ status: 'PENDING' })
    .populate('conflictingUser', 'name role')
    .populate('currentUser', 'name role')
    .sort({ createdAt: 1 })
    .lean()
  return conflicts.map(conflictDto)
}

export async function resolveConflict(conflictId, input, resolverId) {
  if (!mongoose.isValidObjectId(conflictId)) throw new ApiError(400, 'Conflict id is invalid')
  const resolution = input?.resolution
  if (!ALLOWED_RESOLUTIONS.includes(resolution)) throw new ApiError(400, 'Choose KEEP_CURRENT, USE_INCOMING, or CUSTOM')
  if (resolution === 'CUSTOM' && !Object.hasOwn(input, 'value')) throw new ApiError(400, 'A custom value is required')

  const conflict = await ConflictRecord.findOne({ _id: conflictId, status: 'PENDING' })
  if (!conflict) throw new ApiError(404, 'Pending conflict not found')

  const record = conflict.recordType === 'PATIENT'
    ? await Patient.findById(conflict.recordId)
    : await ASHAVisit.findById(conflict.recordId)
  if (!record) throw new ApiError(404, 'Conflicted record no longer exists')

  const currentValue = getPathValue(record, conflict.field)
  let finalValue = currentValue
  if (resolution === 'USE_INCOMING') finalValue = conflict.incomingValue
  if (resolution === 'CUSTOM') finalValue = input.value
    if (resolution !== 'KEEP_CURRENT') {
    if (!sameValue(currentValue, conflict.currentValue)) {
      throw new ApiError(409, 'The record changed again; review its current value before resolving')
    }
    if (conflict.recordType === 'PATIENT') finalValue = normalizePatientField(conflict.field, finalValue)
    setPathValue(record, conflict.field, finalValue)
    if (conflict.recordType === 'ASHA_VISIT' && ASSESSMENT_FIELDS.has(conflict.field)) {
      for (const [path, value] of Object.entries(resetAssessmentFields())) record.set(path, value)
    }
    if (!(record.fieldUpdatedBy instanceof Map)) record.fieldUpdatedBy = new Map()
    record.fieldUpdatedBy.set(conflict.field, resolverId)
    record.version += 1
    record.updatedBy = resolverId
    record.clientOperationId = `resolve_${conflict._id.toString()}`
    try {
      await record.save()
    } catch (error) {
      if (error.name === 'VersionError') throw new ApiError(409, 'The record changed while resolving; reload the conflict')
      if (error.name === 'ValidationError') throw new ApiError(400, error.message)
      throw error
    }
  }

  conflict.status = 'RESOLVED'
  conflict.resolvedBy = resolverId
  conflict.resolution = resolution
  conflict.resolvedValue = finalValue
  conflict.resolvedAt = new Date()
  try {
    await conflict.save()
  } catch (error) {
    if (error.name === 'VersionError') throw new ApiError(409, 'Another reviewer resolved this conflict; refresh the list')
    throw error
  }
  await appendConflictAuditEvent({ conflict, actorId: resolverId, action: 'CONFLICT_REVIEWED' })
  await appendConflictAuditEvent({ conflict, actorId: resolverId, action: 'CONFLICT_RESOLVED', resolution })
  return conflictDto(conflict)
}
