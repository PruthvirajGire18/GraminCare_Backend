import { Router } from 'express'
import { getPendingConflicts, resolvePendingConflict } from '../controllers/conflict.controller.js'
import { requireAuth } from '../middleware/auth.middleware.js'
import { requireRole } from '../middleware/role.middleware.js'

const conflictRouter = Router()
conflictRouter.use(requireAuth, requireRole('ADMIN', 'DOCTOR'))
conflictRouter.get('/', getPendingConflicts)
conflictRouter.patch('/:conflictId/resolve', resolvePendingConflict)

export default conflictRouter
