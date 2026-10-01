export function errorHandler(error, _request, response, _next) {
  if (response.headersSent) {
    return
  }

  if (error.type === 'entity.too.large') {
    response.status(413).json({ success: false, message: 'Request body is too large' })
    return
  }

  if (error.name === 'ValidationError' || error.name === 'CastError' || error.type === 'entity.parse.failed') {
    response.status(400).json({ success: false, message: error.type === 'entity.parse.failed' ? 'Invalid JSON request body' : 'Invalid request data' })
    return
  }

  const statusCode = Number(error.statusCode) || 500
  const payload = {
    success: false,
    message: statusCode >= 500 ? 'Internal server error' : error.message,
  }

  if (error.code && statusCode < 500) {
    payload.code = error.code
  }

  response.status(statusCode).json(payload)
}
