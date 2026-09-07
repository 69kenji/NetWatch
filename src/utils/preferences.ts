import type { QualityFilter } from '../types/torrents'

export type NetWatchUiPreferences = {
  defaultQuality: QualityFilter
  subtitleLanguage: string
  showStartupDetails: boolean
  onClose: 'minimize-to-tray' | 'exit'
  keepWatchingEnabled: boolean
  keepWatchingLimit: number
  flareSolverrEnabled: boolean
  resourceProfile: 'standard' | 'reduced'
  homeLayout: 'standard' | 'cinematic'
}

const DEFAULT_UI_PREFERENCES: NetWatchUiPreferences = {
  defaultQuality: 'all',
  subtitleLanguage: 'en',
  showStartupDetails: false,
  onClose: 'exit',
  keepWatchingEnabled: true,
  keepWatchingLimit: 5,
  flareSolverrEnabled: false,
  resourceProfile: 'standard',
  homeLayout: 'standard',
}

const STORAGE_KEY = 'netwatch-ui-preferences-v1'

export function loadUiPreferences(): NetWatchUiPreferences {
  if (typeof window === 'undefined') return DEFAULT_UI_PREFERENCES
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY)
    if (!raw) return DEFAULT_UI_PREFERENCES
    const parsed = JSON.parse(raw)
    return {
      defaultQuality: ['all', '2160p', '1080p', '720p'].includes(parsed?.defaultQuality)
        ? parsed.defaultQuality
        : DEFAULT_UI_PREFERENCES.defaultQuality,
      subtitleLanguage: typeof parsed?.subtitleLanguage === 'string' && parsed.subtitleLanguage
        ? parsed.subtitleLanguage
        : DEFAULT_UI_PREFERENCES.subtitleLanguage,
      showStartupDetails: Boolean(parsed?.showStartupDetails),
      onClose: parsed?.onClose === 'minimize-to-tray' ? 'minimize-to-tray' : 'exit',
      keepWatchingEnabled: typeof parsed?.keepWatchingEnabled === 'boolean' ? parsed.keepWatchingEnabled : true,
      keepWatchingLimit: Number.isInteger(parsed?.keepWatchingLimit) && parsed.keepWatchingLimit >= 1 && parsed.keepWatchingLimit <= 20
        ? parsed.keepWatchingLimit
        : 5,
      flareSolverrEnabled: Boolean(parsed?.flareSolverrEnabled),
      resourceProfile: parsed?.resourceProfile === 'reduced' ? 'reduced' : 'standard',
      homeLayout: parsed?.homeLayout === 'cinematic' ? 'cinematic' : 'standard',
    }
  } catch {
    return DEFAULT_UI_PREFERENCES
  }
}

export function saveUiPreferences(next: NetWatchUiPreferences) {
  if (typeof window === 'undefined') return
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(next))
  } catch {
    // UI preferences are best-effort. Playback must never depend on localStorage.
  }
}
