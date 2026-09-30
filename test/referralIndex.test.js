import assert from 'node:assert/strict'
import test from 'node:test'
import { removeReferralExpiryTtlIndexes } from '../src/services/referralIndex.service.js'

test('referral startup migration drops only an expiresAt TTL index', async () => {
  const dropped = []
  const collection = {
    async indexes() {
      return [
        { name: '_id_', key: { _id: 1 } },
        { name: 'expiresAt_1', key: { expiresAt: 1 } },
        { name: 'expiresAt_ttl', key: { expiresAt: 1 }, expireAfterSeconds: 0 },
        { name: 'patient_1_status_1', key: { patient: 1, status: 1 }, expireAfterSeconds: 0 },
      ]
    },
    async dropIndex(name) { dropped.push(name) },
  }

  const removed = await removeReferralExpiryTtlIndexes(collection)
  assert.deepEqual(removed, ['expiresAt_ttl'])
  assert.deepEqual(dropped, ['expiresAt_ttl'])
})
