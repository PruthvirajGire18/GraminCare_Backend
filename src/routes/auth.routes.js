import { Router } from 'express'
import { currentUser, login, logout, register } from '../controllers/auth.controller.js'
import { requireAuth } from '../middleware/auth.middleware.js'

const authRouter = Router()

authRouter.post('/register', register)
authRouter.post('/login', login)
authRouter.post('/logout', logout)
authRouter.get('/me', requireAuth, currentUser)

export default authRouter
