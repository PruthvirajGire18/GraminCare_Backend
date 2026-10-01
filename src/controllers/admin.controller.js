import { decideRegistration, listUsers, updateUserStatus } from '../services/admin.service.js'
import { writeSecurityAuditEvent } from '../services/securityAudit.service.js'

export async function getUsers(_request, response) {
  const users = await listUsers()
  response.status(200).json({ success: true, users })
}

export async function approveUser(request, response) {
  const user = await decideRegistration(request.params.id, 'APPROVED')
  await writeSecurityAuditEvent({ actor: request.user._id, actorRole: request.user.role, action: 'USER_APPROVED', resourceType: 'USER', resourceId: user.id })
  response.status(200).json({ success: true, user })
}

export async function rejectUser(request, response) {
  const user = await decideRegistration(request.params.id, 'REJECTED')
  await writeSecurityAuditEvent({ actor: request.user._id, actorRole: request.user.role, action: 'USER_REJECTED', resourceType: 'USER', resourceId: user.id })
  response.status(200).json({ success: true, user })
}

export async function changeUserStatus(request, response) {
  const user = await updateUserStatus(request.params.id, request.body?.status, request.user._id.toString())
  await writeSecurityAuditEvent({ actor: request.user._id, actorRole: request.user.role, action: 'USER_STATUS_CHANGED', resourceType: 'USER', resourceId: user.id })
  response.status(200).json({ success: true, user })
}
