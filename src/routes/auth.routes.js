import { Router } from 'express'
import { currentUser, login, logout, register } from '../controllers/auth.controller.js'
import { requireAuth } from '../middleware/auth.middleware.js'
import { loginRateLimiter, registrationRateLimiter } from '../middleware/rateLimit.middleware.js'

const authRouter = Router()

authRouter.post('/register', registrationRateLimiter, register)
authRouter.post('/login', loginRateLimiter, login)
authRouter.post('/logout', logout)
authRouter.get('/me', requireAuth, currentUser)

export default authRouter
