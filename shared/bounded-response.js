'use strict'

const MAX_JSON_BYTES = 8 * 1024 * 1024

async function readResponseLimited(response, maxBytes = MAX_JSON_BYTES) {
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) throw new Error('Invalid response limit')
  const reader = response.body?.getReader()
  if (!reader) return Buffer.alloc(0)
  const chunks = []
  let total = 0
  try {
    if (Number(response.headers.get('content-length')) > maxBytes) throw new Error('Response exceeds the size limit')
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      total += value.byteLength
      if (total > maxBytes) throw new Error('Response exceeds the size limit')
      chunks.push(Buffer.from(value))
    }
    return Buffer.concat(chunks, total)
  } catch (error) {
    await reader.cancel().catch(() => {})
    throw error
  } finally {
    reader.releaseLock()
  }
}

module.exports = { readResponseLimited, MAX_JSON_BYTES }
