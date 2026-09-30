import { Router } from 'express'
import { approveUser, changeUserStatus, getUsers, rejectUser } from '../controllers/admin.controller.js'
import { requireAuth } from '../middleware/auth.middleware.js'
import { requireRole } from '../middleware/role.middleware.js'

const adminRouter = Router()
adminRouter.use(requireAuth, requireRole('ADMIN'))
adminRouter.get('/users', getUsers)
adminRouter.patch('/users/:id/approve', approveUser)
adminRouter.patch('/users/:id/reject', rejectUser)
adminRouter.patch('/users/:id/status', changeUserStatus)

export default adminRouter
