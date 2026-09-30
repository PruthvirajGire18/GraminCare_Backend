import ApiError from '../utils/ApiError.js'

export function requireRole(...allowedRoles) {
  return function checkRole(request, _response, next) {
    if (!request.user || !allowedRoles.includes(request.user.role)) {
      next(new ApiError(403, 'You do not have permission to access this resource', 'ROLE_FORBIDDEN'))
      return
    }
    next()
  }
}
