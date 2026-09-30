import { Router } from 'express'
import {
  getAssessments,
  getCase,
  getCases,
  getDashboard,
  postConsultation,
  postPrescription,
  postReferral,
  takeCase,
} from '../controllers/doctor.controller.js'
import { requireAuth } from '../middleware/auth.middleware.js'
import { requireRole } from '../middleware/role.middleware.js'

const doctorRouter = Router()
doctorRouter.use(requireAuth, requireRole('DOCTOR'))
doctorRouter.get('/dashboard', getDashboard)
doctorRouter.get('/cases', getCases)
doctorRouter.get('/cases/:patientId', getCase)
doctorRouter.post('/cases/:patientId/take', takeCase)
doctorRouter.post('/cases/:patientId/consultations', postConsultation)
doctorRouter.post('/cases/:patientId/prescriptions', postPrescription)
doctorRouter.post('/cases/:patientId/referrals', postReferral)
doctorRouter.get('/assessments', getAssessments)

export default doctorRouter
