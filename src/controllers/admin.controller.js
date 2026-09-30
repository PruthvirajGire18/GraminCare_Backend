import { decideRegistration, listUsers, updateUserStatus } from '../services/admin.service.js'

export async function getUsers(_request, response) {
  const users = await listUsers()
  response.status(200).json({ success: true, users })
}

export async function approveUser(request, response) {
  const user = await decideRegistration(request.params.id, 'APPROVED')
  response.status(200).json({ success: true, user })
}

export async function rejectUser(request, response) {
  const user = await decideRegistration(request.params.id, 'REJECTED')
  response.status(200).json({ success: true, user })
}

export async function changeUserStatus(request, response) {
  const user = await updateUserStatus(request.params.id, request.body?.status, request.user._id.toString())
  response.status(200).json({ success: true, user })
}
