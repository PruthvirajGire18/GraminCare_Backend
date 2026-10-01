import ApiError from '../utils/ApiError.js'

const FORBIDDEN_KEYS = new Set(['__proto__', 'prototype', 'constructor'])

function containsUnsafeKey(value, depth = 0) {
  if (!value || typeof value !== 'object') return false
  if (depth > 40) return true
  return Object.entries(value).some(([key, child]) => (
    key.startsWith('$') || FORBIDDEN_KEYS.has(key) || containsUnsafeKey(child, depth + 1)
  ))
}

export function rejectUnsafeRequestKeys(request, _response, next) {
  if (containsUnsafeKey(request.body) || containsUnsafeKey(request.query)) {
    next(new ApiError(400, 'Request contains unsupported fields', 'UNSAFE_REQUEST_FIELDS'))
    return
  }
  next()
}
