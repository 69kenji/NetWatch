import type { QualityFilter } from '../types/torrents'

export type NetWatchUiPreferences = {
  defaultQuality: QualityFilter
  subtitleLanguage: string
  showStartupDetails: boolean
}

const DEFAULT_UI_PREFERENCES: NetWatchUiPreferences = {
  defaultQuality: 'all',
  subtitleLanguage: 'en',
  showStartupDetails: false,
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
