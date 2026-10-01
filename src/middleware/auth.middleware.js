import jwt from 'jsonwebtoken'
import { env } from '../config/env.js'
import User from '../models/User.js'
import { AUTH_COOKIE_NAME } from '../utils/authCookie.js'
import ApiError from '../utils/ApiError.js'

export async function requireAuth(request, _response, next) {
  const token = request.cookies?.[AUTH_COOKIE_NAME]
  if (!token) {
    next(new ApiError(401, 'Authentication required', 'AUTH_REQUIRED'))
    return
  }

  try {
    const payload = jwt.verify(token, env.jwtSecret, {
      algorithms: ['HS256'],
      issuer: 'fieldsync-api',
      audience: 'fieldsync-web',
    })
    if (typeof payload.sub !== 'string' || !Number.isInteger(payload.ver) || payload.ver < 0) {
      throw new ApiError(401, 'Session is invalid or expired', 'INVALID_SESSION')
    }
    const user = await User.findById(payload.sub)
    if (!user) {
      throw new ApiError(401, 'Session is no longer valid', 'INVALID_SESSION')
    }
    if (user.status !== 'APPROVED') {
      throw new ApiError(403, 'Account is not approved or active', 'ACCOUNT_NOT_APPROVED')
    }
    if (Number(user.tokenVersion || 0) !== payload.ver) {
      throw new ApiError(401, 'Session is no longer valid', 'INVALID_SESSION')
    }
    request.user = user
    next()
  } catch (error) {
    if (error instanceof ApiError) {
      next(error)
      return
    }
    next(new ApiError(401, 'Session is invalid or expired', 'INVALID_SESSION'))
  }
}
