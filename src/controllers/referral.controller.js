import { verifyReferralToken } from '../services/referral.service.js'

export async function postVerifyReferral(request, response) {
  const referral = await verifyReferralToken(request.body?.token)
  response.status(200).json({ success: true, referral })
}
