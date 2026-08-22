const METADATA_PREPARATION_TIMEOUT_MS = 60_000

function metadataPreparationTimedOut(status, elapsedMs) {
  return Boolean(
    status
      && status.ready !== true
      && status.stage === 'metadata'
      && Number.isFinite(elapsedMs)
      && elapsedMs >= METADATA_PREPARATION_TIMEOUT_MS
  )
}

module.exports = {
  METADATA_PREPARATION_TIMEOUT_MS,
  metadataPreparationTimedOut,
}
