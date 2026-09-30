import assert from 'node:assert/strict'
import test from 'node:test'
import ASHAVisit from '../src/models/ASHAVisit.js'
import AuditLog from '../src/models/AuditLog.js'
import ConflictRecord from '../src/models/ConflictRecord.js'
import Patient from '../src/models/Patient.js'
import { applyVersionedChanges, resolveConflict } from '../src/services/conflict.service.js'

function objectId(value) {
  return { toString: () => value }
}

function createVisitState() {
  const visitId = '507f1f77bcf86cd799439011'
  const patientId = '507f191e810c19729de860ea'
  const ownerId = '507f1f77bcf86cd799439012'
  const state = {
    _id: objectId(visitId),
    patient: objectId(patientId),
    ashaWorker: objectId(ownerId),
    version: 1,
    updatedBy: ownerId,
    clientOperationId: 'initial-create-operation-id',
    symptoms: { chiefComplaint: 'Fever', details: '' },
    vitals: { temperatureC: 37, oxygenSaturationPercent: 98 },
    aiAssessment: {},
    set(path, value) {
      const parts = path.split('.')
      const last = parts.pop()
      const target = parts.reduce((current, part) => current[part], this)
      target[last] = value
    },
    async save() {},
  }
  const patient = {
    _id: objectId(patientId),
    createdBy: objectId(ownerId),
    ashaWorkers: [objectId(ownerId), objectId('507f191e810c19729de860eb')],
    status: 'ACTIVE',
  }
  return { state, patient, visitId, patientId, ownerId }
}

function installMockCollections({ state, patient }) {
  const originalPatientFindOne = Patient.findOne
  const originalVisitFindOne = ASHAVisit.findOne
  const originalConflictFind = ConflictRecord.find
  const originalConflictUpdateOne = ConflictRecord.updateOne
  const originalAuditUpdateOne = AuditLog.updateOne
  const savedConflicts = []
  const auditEvents = []

  Patient.findOne = async () => patient
  ASHAVisit.findOne = async (filter) => (filter._id ? state : null)
  ConflictRecord.find = () => ({
    sort() {
      return {
        lean: async () => savedConflicts,
      }
    },
  })
  ConflictRecord.updateOne = async (filter, update) => {
    if (!savedConflicts.some((conflict) => conflict.clientOperationId === filter.clientOperationId && conflict.field === filter.field)) {
      const conflictId = objectId(`conflict-${savedConflicts.length + 1}`)
      savedConflicts.push({ _id: conflictId, ...update.$setOnInsert })
      return { upsertedCount: 1, upsertedId: conflictId }
    }
    return { upsertedCount: 0, upsertedId: null }
  }
  AuditLog.updateOne = async (_filter, update) => {
    for (const event of Object.values(update.$set).filter((value) => value && typeof value === 'object' && value.action)) {
      auditEvents.push(event)
    }
    return { acknowledged: true }
  }

  const restore = () => {
    Patient.findOne = originalPatientFindOne
    ASHAVisit.findOne = originalVisitFindOne
    ConflictRecord.find = originalConflictFind
    ConflictRecord.updateOne = originalConflictUpdateOne
    AuditLog.updateOne = originalAuditUpdateOne
  }
  restore.auditEvents = auditEvents
  return restore
}

test('conflict and audit schemas preserve field values, actors, status, and resolution', () => {
  assert.deepEqual(ConflictRecord.schema.path('status').enumValues, ['PENDING', 'RESOLVED'])
  for (const field of ['patientId', 'field', 'oldValue', 'incomingValue', 'currentValue', 'conflictingUser', 'createdAt']) {
    assert.ok(ConflictRecord.schema.path(field), `missing conflict field: ${field}`)
  }
  assert.ok(ConflictRecord.schema.path('resolvedBy'))
  assert.ok(ConflictRecord.schema.path('resolvedAt'))
  assert.ok(AuditLog.schema.path('conflictId').options.unique)
  assert.ok(AuditLog.schema.path('events.detected'))
})

test('two offline ASHA devices auto-merge non-overlapping fields and conflict on the same field', async () => {
  const fixture = createVisitState()
  const restore = installMockCollections(fixture)
  const ashaA = '507f1f77bcf86cd7994390a1'
  const ashaB = '507f1f77bcf86cd7994390b2'

  try {
    const temperatureUpdate = await applyVersionedChanges({
      recordType: 'ASHA_VISIT',
      recordId: fixture.visitId,
      patientId: fixture.patientId,
      changes: { vitals: { temperatureC: 38.9 } },
      baseValues: { 'vitals.temperatureC': 37 },
      baseVersion: 1,
      clientOperationId: 'asha-a-temperature-operation',
      userId: ashaA,
    })
    assert.equal(temperatureUpdate.record.version, 2)
    assert.deepEqual(temperatureUpdate.conflicts, [])

    const spO2Update = await applyVersionedChanges({
      recordType: 'ASHA_VISIT',
      recordId: fixture.visitId,
      patientId: fixture.patientId,
      changes: { vitals: { oxygenSaturationPercent: 94 } },
      baseValues: { 'vitals.oxygenSaturationPercent': 98 },
      baseVersion: 1,
      clientOperationId: 'asha-b-spo2-operation',
      userId: ashaB,
    })
    assert.equal(spO2Update.record.version, 3)
    assert.equal(fixture.state.vitals.temperatureC, 38.9)
    assert.equal(fixture.state.vitals.oxygenSaturationPercent, 94)
    assert.deepEqual(spO2Update.conflicts, [])

    const competingTemperatureUpdate = await applyVersionedChanges({
      recordType: 'ASHA_VISIT',
      recordId: fixture.visitId,
      patientId: fixture.patientId,
      changes: { vitals: { temperatureC: 38.3 } },
      baseValues: { 'vitals.temperatureC': 37 },
      baseVersion: 1,
      clientOperationId: 'asha-b-temperature-operation',
      userId: ashaB,
    })

    assert.equal(competingTemperatureUpdate.record.version, 3)
    assert.equal(fixture.state.vitals.temperatureC, 38.9)
    assert.equal(competingTemperatureUpdate.conflicts.length, 1)
    assert.deepEqual({
      patientId: competingTemperatureUpdate.conflicts[0].patientId,
      field: competingTemperatureUpdate.conflicts[0].field,
      oldValue: competingTemperatureUpdate.conflicts[0].oldValue,
      incomingValue: competingTemperatureUpdate.conflicts[0].incomingValue,
      currentValue: competingTemperatureUpdate.conflicts[0].currentValue,
      currentUser: competingTemperatureUpdate.conflicts[0].currentUser,
      conflictingUser: competingTemperatureUpdate.conflicts[0].conflictingUser,
      status: competingTemperatureUpdate.conflicts[0].status,
    }, {
      patientId: fixture.patientId,
      field: 'vitals.temperatureC',
      oldValue: 37,
      incomingValue: 38.3,
      currentValue: 38.9,
      currentUser: ashaA,
      conflictingUser: ashaB,
      status: 'PENDING',
    })

    await applyVersionedChanges({
      recordType: 'ASHA_VISIT',
      recordId: fixture.visitId,
      patientId: fixture.patientId,
      changes: { vitals: { temperatureC: 38.3 } },
      baseValues: { 'vitals.temperatureC': 37 },
      baseVersion: 1,
      clientOperationId: 'asha-b-temperature-operation',
      userId: ashaB,
    })
    assert.equal(restore.auditEvents.filter((event) => event.action === 'CONFLICT_DETECTED').length, 1)
  } finally {
    restore()
  }
})

test('conflict resolution applies the selected incoming value and writes an audit record', async () => {
  const fixture = createVisitState()
  fixture.state.vitals.temperatureC = 38.9
  fixture.state.version = 2
  const conflictId = '507f191e810c19729de860ec'
  const conflict = {
    _id: objectId(conflictId),
    patientId: fixture.patient._id,
    recordType: 'ASHA_VISIT',
    recordId: fixture.state._id,
    field: 'vitals.temperatureC',
    oldValue: 37,
    incomingValue: 38.3,
    currentValue: 38.9,
    conflictingUser: objectId('507f1f77bcf86cd7994390b2'),
    currentUser: objectId('507f1f77bcf86cd7994390a1'),
    clientOperationId: 'asha-b-temperature-operation',
    baseVersion: 1,
    currentVersion: 2,
    status: 'PENDING',
    async save() {},
  }
  const originalConflictFindOne = ConflictRecord.findOne
  const originalVisitFindById = ASHAVisit.findById
  const originalAuditUpdateOne = AuditLog.updateOne
  const auditEvents = []
  ConflictRecord.findOne = async () => conflict
  ASHAVisit.findById = async () => fixture.state
  AuditLog.updateOne = async (_filter, update) => {
    for (const event of Object.values(update.$set).filter((value) => value && typeof value === 'object' && value.action)) {
      auditEvents.push(event)
    }
  }

  try {
    const result = await resolveConflict(conflictId, { resolution: 'USE_INCOMING' }, '507f191e810c19729de860ed')
    assert.equal(fixture.state.vitals.temperatureC, 38.3)
    assert.equal(fixture.state.version, 3)
    assert.equal(result.status, 'RESOLVED')
    assert.equal(result.resolution, 'USE_INCOMING')
    assert.deepEqual(auditEvents.map((event) => event.action), ['CONFLICT_REVIEWED', 'CONFLICT_RESOLVED'])
    assert.ok(auditEvents.every((event) => event.actor === '507f191e810c19729de860ed'))
    assert.ok(auditEvents.every((event) => event.resourceId === fixture.state._id))
  } finally {
    ConflictRecord.findOne = originalConflictFindOne
    ASHAVisit.findById = originalVisitFindById
    AuditLog.updateOne = originalAuditUpdateOne
  }
})
