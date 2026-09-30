import { clearAuthCookie, AUTH_COOKIE_NAME, AUTH_COOKIE_OPTIONS } from '../utils/authCookie.js'
import { loginUser, registerUser } from '../services/auth.service.js'
import { toUserDto } from '../utils/userDto.js'

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
  response.status(200).json({ success: true, user })
}

export function logout(_request, response) {
  clearAuthCookie(response)
  response.status(200).json({ success: true, message: 'You have been logged out' })
}

export function currentUser(request, response) {
  response.status(200).json({ success: true, user: toUserDto(request.user) })
}
