import { fileURLToPath } from 'node:url'
import dotenv from 'dotenv'

dotenv.config({ path: fileURLToPath(new URL('../.env', import.meta.url)) })

const nodeEnv = process.env.NODE_ENV || 'development'
const configuredAiMode = typeof process.env.AI_MODE === 'string' ? process.env.AI_MODE.trim().toLowerCase() : ''

export const env = {
  port: Number(process.env.PORT) || 5000,
  clientOrigin: process.env.CLIENT_ORIGIN || 'http://localhost:5173',
  mongoUri: process.env.MONGODB_URI,
  jwtSecret: process.env.JWT_SECRET,
  nodeEnv,
  // Demo results are limited to development. Production always requires the real backend provider.
  aiMode: nodeEnv === 'production' ? 'openai' : (configuredAiMode === 'openai' ? 'openai' : 'mock'),
  openaiApiKey: process.env.OPENAI_API_KEY || '',
  openaiModel: process.env.OPENAI_MODEL || 'gpt-4o-mini',
}
