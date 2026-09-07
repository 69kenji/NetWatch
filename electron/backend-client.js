'use strict'

function backendErrorMessage(payload, fallback) {
  const detail = payload?.detail
  if (typeof detail === 'string' && detail.trim()) return detail
  if (detail && typeof detail === 'object') {
    if (typeof detail.message === 'string' && detail.message.trim()) return detail.message
    if (typeof detail.error === 'string' && detail.error.trim()) return detail.error
  }
  return fallback
}

function createBackendJson(baseUrl) {
  const normalizedBaseUrl = String(baseUrl || '').replace(/\/+$/u, '')
  if (!normalizedBaseUrl) throw new Error('Backend base URL is required')

  return async function backendJson(pathname, options = {}, timeoutMs = 10_000) {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    try {
      const response = await fetch(`${normalizedBaseUrl}${pathname}`, {
        ...options,
        signal: controller.signal,
        headers: {
          'Cache-Control': 'no-store',
          ...(options.headers || {}),
        },
      })
      const text = await response.text()
      let payload = null
      try { payload = text ? JSON.parse(text) : null } catch (_) {}

      if (!response.ok) {
        const error = new Error(backendErrorMessage(payload, `backend returned HTTP ${response.status}`))
        error.status = response.status
        error.payload = payload
        throw error
      }
      return payload
    } finally {
      clearTimeout(timer)
    }
  }
}

module.exports = { createBackendJson }
