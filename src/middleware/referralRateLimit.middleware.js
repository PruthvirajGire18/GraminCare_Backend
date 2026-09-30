export function createReferralRateLimiter({ windowMs = 15 * 60 * 1000, maxRequests = 30, now = Date.now } = {}) {
  const attemptsByIp = new Map()

  return function referralVerificationLimiter(request, response, next) {
    const currentTime = now()
    const ip = request.ip || request.socket?.remoteAddress || 'unknown'
    let bucket = attemptsByIp.get(ip)
    if (!bucket || currentTime - bucket.startedAt >= windowMs) {
      bucket = { startedAt: currentTime, count: 0 }
      attemptsByIp.set(ip, bucket)
    }
    if (bucket.count >= maxRequests) {
      return response.status(429).json({
        success: false,
        code: 'REFERRAL_VERIFY_RATE_LIMITED',
        message: 'Too many referral verification attempts. Try again later.',
      })
    }
    bucket.count += 1

    if (attemptsByIp.size > 10000) {
      for (const [key, value] of attemptsByIp) {
        if (currentTime - value.startedAt >= windowMs) attemptsByIp.delete(key)
      }
    }
    return next()
  }
}

export const referralVerificationLimiter = createReferralRateLimiter()
