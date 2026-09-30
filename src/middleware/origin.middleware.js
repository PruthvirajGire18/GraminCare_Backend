import { env } from '../config/env.js'
import ApiError from '../utils/ApiError.js'

const READ_METHODS = new Set(['GET', 'HEAD', 'OPTIONS'])

export function isAllowedOrigin(origin) {
  if (!origin) {
    return true
  }
  if (origin === env.clientOrigin) {
    return true
  }
  if (env.nodeEnv === 'production') {
    return false
  }

  try {
    const parsedOrigin = new URL(origin)
    return parsedOrigin.protocol === 'http:'
      && ['localhost', '127.0.0.1'].includes(parsedOrigin.hostname)
  } catch {
    return false
  }
}

export function enforceSameOrigin(request, _response, next) {
  const origin = request.get('origin')
  if (!READ_METHODS.has(request.method) && origin && !isAllowedOrigin(origin)) {
    next(new ApiError(403, 'Request origin is not allowed', 'ORIGIN_FORBIDDEN'))
    return
  }
  next()
}
