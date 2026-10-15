import axios from 'axios'

export const BACKEND_BASE_URL = 'http://127.0.0.1:8000'

export const api = axios.create({
  baseURL: BACKEND_BASE_URL,
  timeout: 10000,
  headers: { 'Content-Type': 'application/json' },
})

// Only reads may be replayed automatically. Downloads and other writes are not idempotent.
api.interceptors.response.use(
  res => res,
  async err => {
    const config = err.config
    const status = err.response?.status
    if (!config || config.__retryCount >= 3 || config.signal?.aborted || err.code === 'ERR_CANCELED' ||
        !['get', 'head'].includes(String(config.method || 'get').toLowerCase()) ||
        (status !== undefined && ![429, 502, 503, 504].includes(status))) return Promise.reject(err)
    config.__retryCount = (config.__retryCount || 0) + 1
    let delay = 800 * config.__retryCount
    const retryAfter = err.response?.headers?.['retry-after']
    if (retryAfter !== undefined) {
      const value = String(retryAfter).trim()
      const requested = /^\d+$/u.test(value) ? Number(value) * 1000 : Date.parse(value) - Date.now()
      // Do not hold the UI open for long rate limits, or retry before they expire.
      if (!Number.isFinite(requested) || requested > 30_000) return Promise.reject(err)
      delay = Math.max(delay, requested)
    } else if (status === 429) return Promise.reject(err)
    await new Promise<void>((resolve, reject) => {
      const signal = config.signal
      const onAbort = () => {
        clearTimeout(timer)
        signal?.removeEventListener('abort', onAbort)
        reject(err)
      }
      const timer = setTimeout(() => {
        signal?.removeEventListener('abort', onAbort)
        resolve()
      }, delay)
      signal?.addEventListener('abort', onAbort, { once: true })
      if (signal?.aborted) onAbort()
    })
    if (config.signal?.aborted) return Promise.reject(err)
    return api(config)
  }
)
