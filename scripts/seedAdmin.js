import bcrypt from 'bcrypt'
import { connectDatabase } from '../src/config/database.js'
import User from '../src/models/User.js'

async function seedAdmin() {
  const email = process.env.ADMIN_EMAIL?.trim().toLowerCase()
  const password = process.env.ADMIN_PASSWORD
  const name = process.env.ADMIN_NAME?.trim() || 'FieldSync Administrator'

  if (!email || !password || Buffer.byteLength(password, 'utf8') < 10 || Buffer.byteLength(password, 'utf8') > 72) {
    throw new Error('Set ADMIN_EMAIL and an ADMIN_PASSWORD between 10 and 72 UTF-8 bytes in server/src/.env')
  }

  await connectDatabase()
  const existingUser = await User.findOne({ email })
  if (existingUser) {
    if (existingUser.role !== 'ADMIN') {
      throw new Error('The configured admin email already belongs to a non-admin user')
    }
    console.log('Administrator account already exists; no changes made.')
    return
  }

  const passwordHash = await bcrypt.hash(password, 12)
  await User.create({ name, email, passwordHash, role: 'ADMIN', status: 'APPROVED' })
  console.log('Administrator account created.')
}

seedAdmin()
  .catch(() => {
    console.error('Admin bootstrap failed. Check MongoDB and ADMIN_* environment settings.')
    process.exitCode = 1
  })
  .finally(async () => {
    const mongoose = await import('mongoose')
    await mongoose.default.disconnect()
  })
