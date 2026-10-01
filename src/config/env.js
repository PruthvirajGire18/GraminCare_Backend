import { fileURLToPath } from 'node:url'
import dotenv from 'dotenv'

dotenv.config({ path: fileURLToPath(new URL('../.env', import.meta.url)) })

const nodeEnv = process.env.NODE_ENV || 'development'
const clientOrigin = process.env.CLIENT_ORIGIN || 'http://localhost:5173'
const configuredAiMode = typeof process.env.AI_MODE === 'string' ? process.env.AI_MODE.trim().toLowerCase() : ''
const trustProxyHops = process.env.TRUST_PROXY_HOPS === undefined
  ? 0
  : Number(process.env.TRUST_PROXY_HOPS)

if (!Number.isInteger(trustProxyHops) || trustProxyHops < 0 || trustProxyHops > 5) {
  throw new Error('TRUST_PROXY_HOPS must be an integer from 0 to 5')
}
if (nodeEnv === 'production' && new URL(clientOrigin).protocol !== 'https:') {
  throw new Error('CLIENT_ORIGIN must use HTTPS in production')
}

export const env = {
  port: Number(process.env.PORT) || 5000,
  clientOrigin,
  mongoUri: process.env.MONGODB_URI,
  jwtSecret: process.env.JWT_SECRET,
  nodeEnv,
  trustProxyHops,
  // Demo results are limited to development. Production always requires the real backend provider.
  aiMode: nodeEnv === 'production' ? 'openai' : (configuredAiMode === 'openai' ? 'openai' : 'mock'),
  openaiApiKey: process.env.OPENAI_API_KEY || '',
  openaiModel: process.env.OPENAI_MODEL || 'gpt-4o-mini',
}
