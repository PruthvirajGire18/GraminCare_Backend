import ASHAVisit from '../models/ASHAVisit.js'
import ConflictRecord from '../models/ConflictRecord.js'
import Patient from '../models/Patient.js'
import Referral from '../models/Referral.js'
import SecurityAuditEvent from '../models/SecurityAuditEvent.js'
import SyncDeviceReport from '../models/SyncDeviceReport.js'
import User from '../models/User.js'

const RISK_LEVELS = ['LOW', 'MEDIUM', 'HIGH', 'CRITICAL']
const SYNC_WINDOW_DAYS = 30
const STALE_DEVICE_HOURS = 24

async function getRiskDistribution() {
  const rows = await ASHAVisit.aggregate([
    { $match: { 'aiAssessment.riskLevel': { $in: RISK_LEVELS } } },
    { $sort: { patient: 1, visitDate: -1, createdAt: -1, _id: -1 } },
    { $group: { _id: '$patient', riskLevel: { $first: '$aiAssessment.riskLevel' } } },
    {
      $lookup: {
        from: Patient.collection.name,
        localField: '_id',
        foreignField: '_id',
        as: 'patient',
      },
    },
    { $unwind: '$patient' },
    { $match: { 'patient.status': 'ACTIVE' } },
    { $group: { _id: '$riskLevel', count: { $sum: 1 } } },
  ])

  return rows.reduce((result, row) => {
    if (RISK_LEVELS.includes(row._id)) result[row._id] = row.count
    return result
  }, { LOW: 0, MEDIUM: 0, HIGH: 0, CRITICAL: 0 })
}

async function getSyncQueueReport() {
  const staleBefore = new Date(Date.now() - STALE_DEVICE_HOURS * 60 * 60 * 1000)
  const [summary] = await SyncDeviceReport.aggregate([
    {
      $lookup: {
        from: User.collection.name,
        localField: 'worker',
        foreignField: '_id',
        as: 'worker',
      },
    },
    { $unwind: '$worker' },
    { $match: { 'worker.role': 'ASHA_WORKER', 'worker.status': 'APPROVED' } },
    {
      $group: {
        _id: null,
        pendingOperations: { $sum: '$pendingOperations' },
        reportedDevices: { $sum: 1 },
        staleDevices: { $sum: { $cond: [{ $lt: ['$reportedAt', staleBefore] }, 1, 0] } },
        lastReportedAt: { $max: '$reportedAt' },
      },
    },
  ])

  return {
    pendingOperations: summary?.pendingOperations || 0,
    reportedDevices: summary?.reportedDevices || 0,
    staleDevices: summary?.staleDevices || 0,
    lastReportedAt: summary?.lastReportedAt || null,
    staleAfterHours: STALE_DEVICE_HOURS,
  }
}

export async function getAdminAnalytics() {
  const now = new Date()
  const syncSince = new Date(now.getTime() - SYNC_WINDOW_DAYS * 24 * 60 * 60 * 1000)
  const referralExpiration = { $or: [{ status: 'EXPIRED' }, { status: 'ACTIVE', expiresAt: { $lte: now } }] }
  const [
    ashaWorkers,
    doctors,
    totalPatients,
    activeCases,
    totalReferrals,
    pendingApprovals,
    activeReferrals,
    usedReferrals,
    expiredReferrals,
    syncSuccessful,
    syncFailed,
    openConflicts,
    riskDistribution,
    syncQueue,
  ] = await Promise.all([
    User.countDocuments({ role: 'ASHA_WORKER', status: { $in: ['APPROVED', 'INACTIVE'] } }),
    User.countDocuments({ role: 'DOCTOR', status: { $in: ['APPROVED', 'INACTIVE'] } }),
    Patient.countDocuments({}),
    Patient.countDocuments({ status: 'ACTIVE', caseStatus: { $ne: 'CLOSED' } }),
    Referral.countDocuments({}),
    User.countDocuments({ role: { $in: ['ASHA_WORKER', 'DOCTOR'] }, status: 'PENDING' }),
    Referral.countDocuments({ status: 'ACTIVE', expiresAt: { $gt: now } }),
    Referral.countDocuments({ status: 'USED' }),
    Referral.countDocuments(referralExpiration),
    SecurityAuditEvent.countDocuments({ action: 'SYNC_COMPLETED', occurredAt: { $gte: syncSince } }),
    SecurityAuditEvent.countDocuments({ action: 'SYNC_FAILED', occurredAt: { $gte: syncSince } }),
    ConflictRecord.countDocuments({ status: 'PENDING' }),
    getRiskDistribution(),
    getSyncQueueReport(),
  ])

  const syncAttempts = syncSuccessful + syncFailed
  return {
    summary: {
      ashaWorkers,
      doctors,
      totalPatients,
      activeCases,
      highRiskCases: riskDistribution.HIGH,
      criticalCases: riskDistribution.CRITICAL,
      totalReferrals,
      pendingApprovals,
      syncSuccessRate: syncAttempts ? Math.round((syncSuccessful / syncAttempts) * 1000) / 10 : null,
    },
    riskDistribution,
    referrals: { active: activeReferrals, used: usedReferrals, expired: expiredReferrals },
    sync: {
      successful: syncSuccessful,
      failed: syncFailed,
      conflicts: openConflicts,
      ...syncQueue,
      windowDays: SYNC_WINDOW_DAYS,
    },
  }
}
