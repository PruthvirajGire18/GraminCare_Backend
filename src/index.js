import app from './app.js'
import { connectDatabase } from './config/database.js'
import { env } from './config/env.js'
import ASHAVisit from './models/ASHAVisit.js'
import AuditLog from './models/AuditLog.js'
import ConflictRecord from './models/ConflictRecord.js'
import DoctorConsultation from './models/DoctorConsultation.js'
import Notification from './models/Notification.js'
import Patient from './models/Patient.js'
import Prescription from './models/Prescription.js'
import Referral from './models/Referral.js'
import { migrateLegacyClinicalRecords } from './services/dataMigration.service.js'
import { startRiskAssessmentWorker } from './services/aiRiskQueue.service.js'

async function startServer() {
  let startupStage = 'configuration validation'
  try {
    if (!env.jwtSecret || env.jwtSecret.length < 32) {
      throw new Error('JWT_SECRET must contain at least 32 characters')
    }

    startupStage = 'MongoDB connection'
    await connectDatabase()
    startupStage = 'clinical metadata migration'
    await migrateLegacyClinicalRecords()
    const models = [
      ['Patient', Patient],
      ['ASHAVisit', ASHAVisit],
      ['ConflictRecord', ConflictRecord],
      ['AuditLog', AuditLog],
      ['DoctorConsultation', DoctorConsultation],
      ['Notification', Notification],
      ['Prescription', Prescription],
      ['Referral', Referral],
    ]
    for (const [modelName, model] of models) {
      startupStage = `index initialization for ${modelName}`
      await model.init()
    }
    startRiskAssessmentWorker()
    startupStage = 'HTTP listener'
    app.listen(env.port, () => {
      console.log(`FieldSync API listening on port ${env.port}`)
    })
  } catch (error) {
    error.startupStage = startupStage
    throw error
  }
}

startServer().catch((error) => {
  const stage = error.startupStage || 'startup'
  const code = error.code ? ` (${error.code})` : ''
  const message = error.message ? `: ${error.message}` : ''
  console.error(`Server startup failed during ${stage}: ${error.name}${code}${message}`)
  process.exitCode = 1
})
