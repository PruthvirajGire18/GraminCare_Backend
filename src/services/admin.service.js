import mongoose from 'mongoose'
import User, { USER_ROLES, USER_STATUSES } from '../models/User.js'
import ApiError from '../utils/ApiError.js'
import { toUserDto } from '../utils/userDto.js'

function validateUserId(userId) {
  if (!mongoose.isValidObjectId(userId)) {
    throw new ApiError(400, 'User id is invalid')
  }
}

async function findManagedUser(userId) {
  validateUserId(userId)
  const user = await User.findById(userId)
  if (!user) {
    throw new ApiError(404, 'User not found')
  }
  return user
}

function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

export async function listUsers(filters = {}) {
  const query = {}
  if (filters.role) {
    if (!USER_ROLES.includes(filters.role)) throw new ApiError(400, 'Role filter is invalid')
    query.role = filters.role
  }
  if (filters.status) {
    if (!USER_STATUSES.includes(filters.status)) throw new ApiError(400, 'Status filter is invalid')
    query.status = filters.status
  }

  const search = typeof filters.search === 'string' ? filters.search.trim().slice(0, 100) : ''
  if (search) {
    const matcher = new RegExp(escapeRegex(search), 'i')
    query.$or = [{ name: matcher }, { email: matcher }]
  }

  const users = await User.find(query).sort({ createdAt: -1 })
  return users.map(toUserDto)
}

export async function decideRegistration(userId, status) {
  const user = await findManagedUser(userId)
  if (user.role === 'ADMIN') {
    throw new ApiError(400, 'Administrator accounts cannot be approved or rejected here')
  }
  if (user.status !== 'PENDING') {
    throw new ApiError(409, 'Only pending registrations can be approved or rejected')
  }

  user.status = status
  user.tokenVersion = (user.tokenVersion || 0) + 1
  await user.save()
  return toUserDto(user)
}

export async function updateUserStatus(userId, status, actingAdminId) {
  if (!USER_STATUSES.includes(status)) {
    throw new ApiError(400, `Status must be one of: ${USER_STATUSES.join(', ')}`)
  }
  if (userId === actingAdminId) {
    throw new ApiError(409, 'Administrators cannot change their own account status')
  }

  const user = await findManagedUser(userId)
  if (user.status !== status) user.tokenVersion = (user.tokenVersion || 0) + 1
  user.status = status
  await user.save()
  return toUserDto(user)
}
