export function createRateLimiter({ windowMs, maxRequests, code, message, now = Date.now } = {}) {
  if (!Number.isFinite(windowMs) || windowMs < 1 || !Number.isInteger(maxRequests) || maxRequests < 1) {
    throw new TypeError('A positive rate-limit window and request count are required')
  }

  const buckets = new Map()

  return function rateLimiter(request, response, next) {
    const currentTime = now()
    const key = request.ip || request.socket?.remoteAddress || 'unknown'
    let bucket = buckets.get(key)
    if (!bucket || currentTime - bucket.startedAt >= windowMs) {
      bucket = { startedAt: currentTime, count: 0 }
      buckets.set(key, bucket)
    }

    if (bucket.count >= maxRequests) {
      const retryAfterSeconds = Math.max(1, Math.ceil((bucket.startedAt + windowMs - currentTime) / 1000))
      response.set('Retry-After', String(retryAfterSeconds))
      return response.status(429).json({ success: false, code, message })
    }

    bucket.count += 1
    if (buckets.size > 10_000) {
      for (const [bucketKey, value] of buckets) {
        if (currentTime - value.startedAt >= windowMs) buckets.delete(bucketKey)
      }
      while (buckets.size > 10_000) buckets.delete(buckets.keys().next().value)
    }
    return next()
  }
}

export const loginRateLimiter = createRateLimiter({
  windowMs: 15 * 60 * 1000,
  maxRequests: 10,
  code: 'LOGIN_RATE_LIMITED',
  message: 'Too many sign-in attempts. Try again later.',
})

export const registrationRateLimiter = createRateLimiter({
  windowMs: 60 * 60 * 1000,
  maxRequests: 10,
  code: 'REGISTRATION_RATE_LIMITED',
  message: 'Too many registration attempts. Try again later.',
})
