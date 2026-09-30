import mongoose from 'mongoose'
import { env } from './env.js'

export async function connectDatabase(uri = env.mongoUri) {
  if (!uri) {
    throw new Error('MONGODB_URI is required to connect to MongoDB')
  }

  await mongoose.connect(uri)
}
