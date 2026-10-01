import SecurityAuditEvent from '../models/SecurityAuditEvent.js'

// Deliberately accepts only identifiers and fixed event labels; request bodies and clinical values are never stored.
export async function writeSecurityAuditEvent({ actor, actorRole, action, resourceType, resourceId = null }) {
  try {
    await SecurityAuditEvent.create({ actor, actorRole, action, resourceType, resourceId })
    return true
  } catch {
    // Keep successful care workflows available if audit persistence is temporarily unavailable.
    // Do not print event payloads or database error details.
    console.error('Security audit event could not be persisted')
    return false
  }
}
