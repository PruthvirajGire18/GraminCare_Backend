import { Router } from 'express'
import { postVerifyReferral } from '../controllers/referral.controller.js'
import { referralVerificationLimiter } from '../middleware/referralRateLimit.middleware.js'

const referralRouter = Router()

// The random QR token is the bearer credential; this route creates no staff account or role.
referralRouter.post('/verify', referralVerificationLimiter, postVerifyReferral)

export default referralRouter
