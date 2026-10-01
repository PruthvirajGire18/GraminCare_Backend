import { clearAuthCookie, AUTH_COOKIE_NAME, AUTH_COOKIE_OPTIONS } from '../utils/authCookie.js'
import { loginUser, registerUser, revokeSession } from '../services/auth.service.js'
import { toUserDto } from '../utils/userDto.js'
import { writeSecurityAuditEvent } from '../services/securityAudit.service.js'

export async function register(request, response) {
  const user = await registerUser(request.body || {})
  response.status(201).json({
    success: true,
    message: 'Registration received. An administrator must approve your account before you can sign in.',
    user,
  })
}

export async function login(request, response) {
  const { token, user } = await loginUser(request.body || {})
  response.cookie(AUTH_COOKIE_NAME, token, AUTH_COOKIE_OPTIONS)
  await writeSecurityAuditEvent({ actor: user.id, actorRole: user.role, action: 'LOGIN', resourceType: 'AUTH', resourceId: user.id })
  response.status(200).json({ success: true, user })
}

export async function logout(request, response) {
  let user
  try {
    user = await revokeSession(request.cookies?.[AUTH_COOKIE_NAME])
  } finally {
    clearAuthCookie(response)
  }
  if (user) {
    await writeSecurityAuditEvent({ actor: user._id, actorRole: user.role, action: 'LOGOUT', resourceType: 'AUTH', resourceId: user._id })
  }
  response.status(200).json({ success: true, message: 'You have been logged out' })
}

export function currentUser(request, response) {
  response.status(200).json({ success: true, user: toUserDto(request.user) })
}
