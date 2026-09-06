'use strict'

function composeRuntimeEnvironment(settings = {}) {
  const reduced = settings.resourceProfile === 'reduced'
  return [
    `NETWATCH_RESOURCE_PROFILE=${reduced ? 'reduced' : 'standard'}`,
    `NETWATCH_RANGE_LOOKAHEAD_BYTES=${reduced ? 16 * 1024 * 1024 : 32 * 1024 * 1024}`,
    `NETWATCH_ACTIVE_DOWNLOADS=${reduced ? 2 : 8}`,
    `NETWATCH_ACTIVE_LIMIT=${reduced ? 4 : 16}`,
    `NETWATCH_CONNECTIONS_LIMIT=${reduced ? 128 : 500}`,
    `NETWATCH_TMPFS_SIZE=${reduced ? '4g' : '8g'}`,
  ]
}

module.exports = { composeRuntimeEnvironment }
