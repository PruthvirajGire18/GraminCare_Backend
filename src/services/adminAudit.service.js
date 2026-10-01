import SecurityAuditEvent, { SECURITY_AUDIT_ACTIONS } from '../models/SecurityAuditEvent.js'
import { USER_ROLES } from '../models/User.js'
import ApiError from '../utils/ApiError.js'

const DEFAULT_PAGE_SIZE = 25
const MAX_PAGE_SIZE = 100

function parsePageNumber(value, fallback, label, maximum = Number.MAX_SAFE_INTEGER) {
  if (value === undefined || value === '') return fallback
  const parsed = Number(value)
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > maximum) {
    throw new ApiError(400, `${label} must be a valid positive integer`)
  }
  return parsed
}

function parseDateBoundary(value, label, endOfDay = false) {
  if (value === undefined || value === '') return null
  if (typeof value !== 'string') throw new ApiError(400, `${label} date is invalid`)

  const date = new Date(value)
  if (Number.isNaN(date.getTime())) throw new ApiError(400, `${label} date is invalid`)
  if (endOfDay && /^\d{4}-\d{2}-\d{2}$/.test(value)) date.setUTCDate(date.getUTCDate() + 1)
  return date
}

export async function listAdminAuditLogs(filters = {}) {
  const page = parsePageNumber(filters.page, 1, 'Page')
  const pageSize = parsePageNumber(filters.pageSize, DEFAULT_PAGE_SIZE, 'Page size', MAX_PAGE_SIZE)
  const match = {}

  if (filters.role) {
    if (!USER_ROLES.includes(filters.role)) throw new ApiError(400, 'Role filter is invalid')
    match.actorRole = filters.role
  }
  if (filters.action) {
    if (!SECURITY_AUDIT_ACTIONS.includes(filters.action)) throw new ApiError(400, 'Action filter is invalid')
    match.action = filters.action
  }

  const from = parseDateBoundary(filters.from, 'Start')
  const to = parseDateBoundary(filters.to, 'End', true)
  if (from && to && from >= to) throw new ApiError(400, 'End date must be on or after the start date')
  if (from || to) {
    match.occurredAt = {}
    if (from) match.occurredAt.$gte = from
    if (to) match.occurredAt.$lt = to
  }

  const [total, events] = await Promise.all([
    SecurityAuditEvent.countDocuments(match),
    SecurityAuditEvent.find(match)
      .select('actor actorRole action resourceType occurredAt')
      .populate({ path: 'actor', select: 'name' })
      .sort({ occurredAt: -1, _id: -1 })
      .skip((page - 1) * pageSize)
      .limit(pageSize)
      .lean(),
  ])

  return {
    entries: events.map((event) => ({
      id: event._id.toString(),
      actorName: event.actor?.name || 'Former user',
      role: event.actorRole,
      action: event.action,
      resourceType: event.resourceType,
      occurredAt: event.occurredAt,
    })),
    page,
    pageSize,
    total,
    totalPages: Math.ceil(total / pageSize),
  }
}
