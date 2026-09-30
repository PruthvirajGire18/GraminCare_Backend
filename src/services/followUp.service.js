import DoctorConsultation from '../models/DoctorConsultation.js'
import { notifyFollowUpMissed } from './notification.service.js'

function dateKey(value) {
  const date = new Date(value)
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
}

function todayKey() {
  return dateKey(new Date())
}

export async function markMissedFollowUps(patientIds = null) {
  if (patientIds && patientIds.length === 0) return 0
  const filter = { followUpDate: { $ne: null }, followUpStatus: 'PENDING' }
  if (patientIds) filter.patient = { $in: patientIds }
  const consultations = await DoctorConsultation.find(filter)
    .populate({ path: 'patient', select: 'fullName createdBy ashaWorkers' })
    .lean()
  const today = todayKey()
  let marked = 0
  for (const consultation of consultations) {
    if (!consultation.followUpDate || dateKey(consultation.followUpDate) >= today) continue
    const result = await DoctorConsultation.updateOne(
      { _id: consultation._id, followUpStatus: 'PENDING' },
      { $set: { followUpStatus: 'MISSED' } },
    )
    if ((result.modifiedCount ?? result.nModified ?? 1) > 0) {
      marked += 1
      if (consultation.patient) await notifyFollowUpMissed(consultation, consultation.patient)
    }
  }
  return marked
}
