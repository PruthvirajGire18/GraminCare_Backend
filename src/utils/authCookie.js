import { env } from '../config/env.js'

export const AUTH_COOKIE_NAME = 'fieldsync_session'
export const AUTH_COOKIE_OPTIONS = {
  httpOnly: true,
  secure: env.nodeEnv === 'production',
  sameSite: env.nodeEnv === 'production' ? 'none' : 'lax',
  path: '/api',
  maxAge: 8 * 60 * 60 * 1000,
}

export function clearAuthCookie(response) {
  const { maxAge: _maxAge, ...options } = AUTH_COOKIE_OPTIONS
  response.clearCookie(AUTH_COOKIE_NAME, options)
}
