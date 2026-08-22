import axios from 'axios'

export const BACKEND_BASE_URL = 'http://127.0.0.1:8000'

export const api = axios.create({
  baseURL: BACKEND_BASE_URL,
  timeout: 10000,
  headers: { 'Content-Type': 'application/json' },
})

// Retry on network errors (backend may still be starting)
api.interceptors.response.use(
  res => res,
  async err => {
    const config = err.config
    if (!config || config.__retryCount >= 3) return Promise.reject(err)
    config.__retryCount = (config.__retryCount || 0) + 1
    await new Promise(r => setTimeout(r, 800 * config.__retryCount))
    return api(config)
  }
)
