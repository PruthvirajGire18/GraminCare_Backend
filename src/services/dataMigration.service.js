import ASHAVisit from '../models/ASHAVisit.js'
import DoctorConsultation from '../models/DoctorConsultation.js'
import Patient from '../models/Patient.js'

const BULK_BATCH_SIZE = 250

async function backfillPatients() {
  let operations = []
  const cursor = Patient.find().select('_id version updatedBy createdBy fieldUpdatedBy clientOperationId').lean().cursor()

  async function flush() {
    if (operations.length) await Patient.bulkWrite(operations, { ordered: false })
    operations = []
  }

  for await (const patient of cursor) {
    const set = {}
    if (!Number.isInteger(patient.version) || patient.version < 1) set.version = 1
    if (!patient.updatedBy) set.updatedBy = patient.createdBy
    if (!patient.fieldUpdatedBy) set.fieldUpdatedBy = {}
    if (!patient.clientOperationId) set.clientOperationId = patient._id.toString()
    operations.push({
      updateOne: {
        filter: { _id: patient._id },
        update: { $set: set, $addToSet: { ashaWorkers: patient.createdBy } },
      },
    })
    if (operations.length >= BULK_BATCH_SIZE) await flush()
  }
  await flush()
}

async function backfillVisits() {
  let operations = []
  const cursor = ASHAVisit.find().select('_id version updatedBy ashaWorker fieldUpdatedBy clientOperationId +aiAssessment').lean().cursor()

  async function flush() {
    if (operations.length) await ASHAVisit.bulkWrite(operations, { ordered: false })
    operations = []
  }

  for await (const visit of cursor) {
    const set = {}
    if (!Number.isInteger(visit.version) || visit.version < 1) set.version = 1
    if (!visit.updatedBy) set.updatedBy = visit.ashaWorker
    if (!visit.fieldUpdatedBy) set.fieldUpdatedBy = {}
    if (!visit.clientOperationId) set.clientOperationId = `visit_${visit._id.toString()}`
    if (!visit.aiAssessment?.status) {
      set['aiAssessment.status'] = 'AI_ASSESSMENT_PENDING'
      set['aiAssessment.attempts'] = 0
      set['aiAssessment.nextAttemptAt'] = new Date()
    }
    if (Object.keys(set).length) operations.push({ updateOne: { filter: { _id: visit._id }, update: { $set: set } } })
    if (operations.length >= BULK_BATCH_SIZE) await flush()
  }
  await flush()
}

async function backfillDoctorFollowUps() {
  await DoctorConsultation.updateMany(
    { followUpDate: { $ne: null }, followUpStatus: null },
    { $set: { followUpStatus: 'PENDING' } },
  )
}

export async function migrateLegacyClinicalRecords() {
  try {
    await backfillPatients()
  } catch (error) {
    error.startupStage = 'patient metadata migration'
    throw error
  }
  try {
    await backfillVisits()
  } catch (error) {
    error.startupStage = 'visit metadata migration'
    throw error
  }
  try {
    await backfillDoctorFollowUps()
  } catch (error) {
    error.startupStage = 'doctor follow-up migration'
    throw error
  }
}
