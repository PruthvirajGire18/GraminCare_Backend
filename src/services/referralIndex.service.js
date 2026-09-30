import Referral from '../models/Referral.js'

// Referral history must remain available after expiresAt so status transitions
// and REFERRAL_EXPIRED audit events can be retained. Older deployments may have
// a TTL index on expiresAt, so remove only that index and preserve normal indexes.
export async function removeReferralExpiryTtlIndexes(collection = Referral.collection) {
  const indexes = await collection.indexes()
  const ttlIndexes = indexes.filter((index) => (
    index.expireAfterSeconds !== undefined
    && Object.keys(index.key || {}).length === 1
    && index.key.expiresAt === 1
  ))

  const removed = []
  for (const index of ttlIndexes) {
    try {
      await collection.dropIndex(index.name)
      removed.push(index.name)
    } catch (error) {
      // Another application instance may finish the same startup migration first.
      if (error.code !== 27 && error.codeName !== 'IndexNotFound') throw error
    }
  }
  return removed
}
