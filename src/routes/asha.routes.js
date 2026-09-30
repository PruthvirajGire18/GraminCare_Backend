import { Router } from 'express'
import {
  deletePatient,
  getDashboard,
  getPatient,
  getPatients,
  getVisit,
  getVisits,
  patchPatient,
  patchVisit,
  postPatient,
  postVisit,
  sharePatient,
} from '../controllers/asha.controller.js'
import { requireAuth } from '../middleware/auth.middleware.js'
import { requireRole } from '../middleware/role.middleware.js'

const ashaRouter = Router()
ashaRouter.use(requireAuth, requireRole('ASHA_WORKER'))
ashaRouter.get('/dashboard', getDashboard)
ashaRouter.get('/patients', getPatients)
ashaRouter.post('/patients', postPatient)
ashaRouter.post('/patients/:patientId/share', sharePatient)
ashaRouter.get('/patients/:patientId', getPatient)
ashaRouter.patch('/patients/:patientId', patchPatient)
ashaRouter.delete('/patients/:patientId', deletePatient)
ashaRouter.get('/patients/:patientId/visits', getVisits)
ashaRouter.post('/patients/:patientId/visits', postVisit)
ashaRouter.get('/patients/:patientId/visits/:visitId', getVisit)
ashaRouter.patch('/patients/:patientId/visits/:visitId', patchVisit)

export default ashaRouter
