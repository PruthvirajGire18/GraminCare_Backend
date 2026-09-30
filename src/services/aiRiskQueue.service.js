import ASHAVisit from '../models/ASHAVisit.js'
import Patient from '../models/Patient.js'
import { buildRiskInput, generateRiskAssessment } from './aiRisk.service.js'

const RETRY_BASE_MS = 30_000
const RETRY_MAX_MS = 6 * 60 * 60 * 1000
const STALE_PROCESSING_MS = 10 * 60 * 1000
const WORKER_BATCH_SIZE = 10

function retryDelay(attempts) {
  return Math.min(RETRY_MAX_MS, RETRY_BASE_MS * (2 ** Math.max(0, attempts - 1)))
}

function withAssessment(query) {
  return query?.select ? query.select('+aiAssessment') : query
}

export function resetAssessmentFields() {
  return {
    'aiAssessment.status': 'AI_ASSESSMENT_PENDING',
    'aiAssessment.riskLevel': null,
    'aiAssessment.riskScore': null,
    'aiAssessment.priority': null,
    'aiAssessment.factors': [],
    'aiAssessment.recommendation': '',
    'aiAssessment.assessedAt': null,
    'aiAssessment.mode': null,
    'aiAssessment.model': null,
    'aiAssessment.attempts': 0,
    'aiAssessment.nextAttemptAt': new Date(),
    'aiAssessment.lastErrorCode': null,
  }
}

export async function processRiskAssessment(visitId, {
  visitModel = ASHAVisit,
  patientModel = Patient,
  assessor = generateRiskAssessment,
  now = new Date(),
} = {}) {
  let claimQuery = visitModel.findOneAndUpdate(
    {
      _id: visitId,
      'aiAssessment.status': 'AI_ASSESSMENT_PENDING',
      $or: [
        { 'aiAssessment.nextAttemptAt': { $lte: now } },
        { 'aiAssessment.nextAttemptAt': null },
      ],
    },
    {
      $set: { 'aiAssessment.status': 'AI_ASSESSMENT_PROCESSING', 'aiAssessment.lastErrorCode': null },
      $inc: { 'aiAssessment.attempts': 1 },
    },
    { new: true },
  )
  claimQuery = withAssessment(claimQuery)
  const visit = await claimQuery
  if (!visit) return { processed: false, status: 'UNCHANGED' }

  try {
    let patientQuery = patientModel.findById(visit.patient)
    if (patientQuery?.select) patientQuery = patientQuery.select('fullName gender dateOfBirth')
    if (patientQuery?.lean) patientQuery = patientQuery.lean()
    const patient = await patientQuery
    if (!patient) throw Object.assign(new Error('PATIENT_NOT_FOUND'), { code: 'PATIENT_NOT_FOUND' })
    const input = buildRiskInput({ patient, visit })
    const assessment = await assessor(input)
    await visitModel.updateOne(
      { _id: visit._id, 'aiAssessment.status': 'AI_ASSESSMENT_PROCESSING' },
      {
        $set: {
          'aiAssessment.status': 'AI_ASSESSED',
          'aiAssessment.riskLevel': assessment.riskLevel,
          'aiAssessment.riskScore': assessment.riskScore,
          'aiAssessment.priority': assessment.priority,
          'aiAssessment.factors': assessment.factors,
          'aiAssessment.recommendation': assessment.recommendation,
          'aiAssessment.assessedAt': new Date(),
          'aiAssessment.mode': assessment.mode,
          'aiAssessment.model': assessment.model,
          'aiAssessment.nextAttemptAt': null,
          'aiAssessment.lastErrorCode': null,
        },
      },
    )
    return { processed: true, status: 'AI_ASSESSED' }
  } catch (error) {
    const attempts = visit.aiAssessment?.attempts || 1
    const nextAttemptAt = new Date(Date.now() + retryDelay(attempts))
    const errorCode = typeof error?.code === 'string' ? error.code.slice(0, 80) : 'AI_UNAVAILABLE'
    await visitModel.updateOne(
      { _id: visit._id, 'aiAssessment.status': 'AI_ASSESSMENT_PROCESSING' },
      {
        $set: {
          'aiAssessment.status': 'AI_ASSESSMENT_PENDING',
          'aiAssessment.nextAttemptAt': nextAttemptAt,
          'aiAssessment.lastErrorCode': errorCode,
        },
      },
    )
    return { processed: true, status: 'AI_ASSESSMENT_PENDING', errorCode }
  }
}

export function enqueueRiskAssessment(visitId) {
  if (!visitId) return
  setImmediate(() => {
    void processRiskAssessment(visitId).catch(() => {})
  })
}

export function startRiskAssessmentWorker({ intervalMs = 30_000 } = {}) {
  let running = false
  const tick = async () => {
    if (running) return
    running = true
    try {
      const now = new Date()
      await ASHAVisit.updateMany(
        { 'aiAssessment.status': 'AI_ASSESSMENT_PROCESSING', updatedAt: { $lte: new Date(now.getTime() - STALE_PROCESSING_MS) } },
        { $set: { 'aiAssessment.status': 'AI_ASSESSMENT_PENDING', 'aiAssessment.nextAttemptAt': now, 'aiAssessment.lastErrorCode': 'AI_WORKER_RESTARTED' } },
      )
      const due = await ASHAVisit.find({
        'aiAssessment.status': 'AI_ASSESSMENT_PENDING',
        $or: [
          { 'aiAssessment.nextAttemptAt': { $lte: now } },
          { 'aiAssessment.nextAttemptAt': null },
        ],
      }).select('_id').sort({ 'aiAssessment.nextAttemptAt': 1 }).limit(WORKER_BATCH_SIZE).lean()
      for (const visit of due) await processRiskAssessment(visit._id)
    } catch {
      // The normal patient/visit API remains available if the background retry pass fails.
    } finally {
      running = false
    }
  }
  const timer = setInterval(() => { void tick() }, intervalMs)
  timer.unref?.()
  void tick()
  return () => clearInterval(timer)
}
