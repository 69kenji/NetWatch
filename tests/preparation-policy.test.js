const test = require('node:test')
const assert = require('node:assert/strict')

const {
  METADATA_PREPARATION_TIMEOUT_MS,
  metadataPreparationTimedOut,
} = require('../electron/preparation-policy')

test('metadata preparation times out at the established 60 second boundary', () => {
  const status = { stage: 'metadata', ready: false }
  assert.equal(metadataPreparationTimedOut(status, METADATA_PREPARATION_TIMEOUT_MS - 1), false)
  assert.equal(metadataPreparationTimedOut(status, METADATA_PREPARATION_TIMEOUT_MS), true)
})

test('non-metadata preparation stages are not rejected by metadata timeout', () => {
  assert.equal(metadataPreparationTimedOut({ stage: 'peers', ready: false }, 120_000), false)
  assert.equal(metadataPreparationTimedOut({ stage: 'buffering', ready: false }, 120_000), false)
  assert.equal(metadataPreparationTimedOut({ stage: 'ready', ready: true }, 120_000), false)
})
