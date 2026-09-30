import Notification from '../models/Notification.js'

function shortPatientId(patient) {
  const id = patient?._id?.toString?.() || patient?.toString?.() || 'unknown'
  return `P${id.slice(-4).toUpperCase()}`
}

function dateLabel(value) {
  return new Date(value).toLocaleDateString()
}

function ashaRecipients(patient) {
  const recipients = [patient.createdBy, ...(patient.ashaWorkers || [])]
  return [...new Map(recipients.filter(Boolean).map((userId) => [userId.toString(), userId])).values()]
}

async function saveNotifications(records) {
  if (!records.length) return
  try {
    await Notification.bulkWrite(records.map((record) => ({
      updateOne: {
        filter: { dedupeKey: record.dedupeKey },
        update: { $setOnInsert: record },
        upsert: true,
      },
    })), { ordered: false })
  } catch (error) {
    // A reminder must never undo a saved consultation or visit.
    console.error(`Follow-up notification persistence failed: ${error.name}${error.code ? ` (${error.code})` : ''}`)
  }
}

async function resolveFollowUpReminders(consultationId) {
  try {
    await Notification.updateMany(
      { consultation: consultationId, type: { $in: ['FOLLOW_UP_DUE', 'FOLLOW_UP_MISSED'] }, resolvedAt: null },
      { $set: { resolvedAt: new Date() } },
    )
  } catch (error) {
    console.error(`Follow-up notification resolution failed: ${error.name}${error.code ? ` (${error.code})` : ''}`)
  }
}

function notificationRecord({ recipient, recipientRole, type, title, message, patient, consultation, visit = null, dueDate }) {
  return {
    recipient,
    recipientRole,
    type,
    title,
    message,
    patient: patient._id,
    consultation: consultation._id,
    visit,
    dueDate,
    dedupeKey: `${type}:${consultation._id}:${recipient}`,
  }
}

export async function notifyFollowUpScheduled(consultation, patient) {
  const patientCode = shortPatientId(patient)
  const dueDate = consultation.followUpDate
  const records = [notificationRecord({
    recipient: consultation.doctor,
    recipientRole: 'DOCTOR',
    type: 'FOLLOW_UP_DUE',
    title: 'Follow-up due',
    message: `Follow-up due for Patient ${patientCode} on ${dateLabel(dueDate)}`,
    patient,
    consultation,
    dueDate,
  })]
  for (const recipient of ashaRecipients(patient)) {
    records.push(notificationRecord({
      recipient,
      recipientRole: 'ASHA_WORKER',
      type: 'FOLLOW_UP_DUE',
      title: 'Follow-up visit required',
      message: `Follow-up visit required for Patient ${patientCode} on ${dateLabel(dueDate)}`,
      patient,
      consultation,
      dueDate,
    }))
  }
  await saveNotifications(records)
}

export async function notifyFollowUpMissed(consultation, patient) {
  await resolveFollowUpReminders(consultation._id)
  const patientCode = shortPatientId(patient)
  const records = [notificationRecord({
    recipient: consultation.doctor,
    recipientRole: 'DOCTOR',
    type: 'FOLLOW_UP_MISSED',
    title: 'Follow-up missed',
    message: `Follow-up missed for Patient ${patientCode}`,
    patient,
    consultation,
    dueDate: consultation.followUpDate,
  })]
  for (const recipient of ashaRecipients(patient)) {
    records.push(notificationRecord({
      recipient,
      recipientRole: 'ASHA_WORKER',
      type: 'FOLLOW_UP_MISSED',
      title: 'Follow-up overdue',
      message: `Follow-up visit overdue for Patient ${patientCode}`,
      patient,
      consultation,
      dueDate: consultation.followUpDate,
    }))
  }
  await saveNotifications(records)
}

export async function notifyFollowUpCompleted(consultation, patient, visit) {
  await resolveFollowUpReminders(consultation._id)
  const record = notificationRecord({
    recipient: consultation.doctor,
    recipientRole: 'DOCTOR',
    type: 'FOLLOW_UP_COMPLETED',
    title: 'Follow-up completed',
    message: `Follow-up completed for Patient ${shortPatientId(patient)}`,
    patient,
    consultation,
    visit: visit._id,
    dueDate: consultation.followUpDate,
  })
  await saveNotifications([record])
}

export async function listNotifications(recipientId, limit = 10) {
  return Notification.find({ recipient: recipientId, resolvedAt: null })
    .sort({ createdAt: -1 })
    .limit(limit)
    .lean()
}
