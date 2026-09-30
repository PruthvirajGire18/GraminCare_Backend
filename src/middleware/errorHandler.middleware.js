export function errorHandler(error, _request, response, _next) {
  if (response.headersSent) {
    return
  }

  if (error.name === 'ValidationError' || error.type === 'entity.parse.failed') {
    response.status(400).json({ success: false, message: error.type ? 'Invalid JSON request body' : error.message })
    return
  }

  const statusCode = Number(error.statusCode) || 500
  const payload = {
    success: false,
    message: statusCode >= 500 ? 'Internal server error' : error.message,
  }

  if (error.code) {
    payload.code = error.code
  }

  response.status(statusCode).json(payload)
}
