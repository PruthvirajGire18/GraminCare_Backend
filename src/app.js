import cookieParser from 'cookie-parser'
import cors from 'cors'
import express from 'express'
import helmet from 'helmet'
import { env } from './config/env.js'
import { errorHandler } from './middleware/errorHandler.middleware.js'
import { rejectUnsafeRequestKeys } from './middleware/requestSecurity.middleware.js'
import { notFound } from './middleware/notFound.middleware.js'
import { enforceSameOrigin, isAllowedOrigin } from './middleware/origin.middleware.js'
import adminRouter from './routes/admin.routes.js'
import ashaRouter from './routes/asha.routes.js'
import apiRouter from './routes/index.js'
import authRouter from './routes/auth.routes.js'
import conflictRouter from './routes/conflict.routes.js'
import doctorRouter from './routes/doctor.routes.js'
import referralRouter from './routes/referral.routes.js'

const app = express()

app.disable('x-powered-by')
app.set('trust proxy', env.trustProxyHops)
app.use(helmet())
app.use(cors({
	origin(origin, callback) {
		callback(null, isAllowedOrigin(origin))
	},
	credentials: true,
}))
app.use(express.json({ limit: '100kb' }))
app.use(cookieParser())
app.use(enforceSameOrigin)
app.use(rejectUnsafeRequestKeys)
app.use('/api/auth', authRouter)
app.use('/api/admin', adminRouter)
app.use('/api/asha', ashaRouter)
app.use('/api/conflicts', conflictRouter)
app.use('/api/referrals', referralRouter)
app.use('/api/doctor', doctorRouter)
app.use('/api', apiRouter)
app.use(notFound)
app.use(errorHandler)

export default app
