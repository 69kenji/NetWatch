import type { QualityFilter } from '../types/torrents'
import { PLAYBACK_DEFAULTS, normalizePlaybackPreferences } from '../../shared/playback-preferences.mjs'
import type { PlaybackPreferences } from '../types/playback'
import { profileStorage } from './profileStorage'
import { DEFAULT_APPEARANCE, normalizeAppearance } from '../../shared/appearance.mjs'
import type { AppearancePreferences } from '../theme/types'

export type NetWatchUiPreferences = PlaybackPreferences & {
  appearance: AppearancePreferences
  defaultQuality: QualityFilter
  subtitleLanguage: string
  showStartupDetails: boolean
  onClose: 'minimize-to-tray' | 'exit'
  startWithWindows: boolean
  startMinimized: boolean
  updateNotifications: boolean
  keepWatchingEnabled: boolean
  keepWatchingLimit: number
  flareSolverrEnabled: boolean
  resourceProfile: 'standard' | 'reduced'
  homeLayout: 'standard' | 'cinematic'
  homeRailOrder: HomeRailKey[]
  hiddenHomeRails: HomeRailKey[]
  trackedSeriesNotifications: boolean
  alwaysSkipIntro: boolean
  interfaceScale: 100 | 115 | 130
  contrastMode: 'standard' | 'strong'
  reducedMotion: boolean
  tvMode: boolean
}

export type HomeRailKey = 'my-list' | 'keep-watching' | 'recommended' | 'trending-movies' | 'recent-movies' | 'trending-tv' | 'recent-tv' | 'trending-anime' | 'recent-anime'
export const HOME_RAIL_ORDER: HomeRailKey[] = ['my-list', 'keep-watching', 'recommended', 'trending-movies', 'recent-movies', 'trending-tv', 'recent-tv', 'trending-anime', 'recent-anime']
export const HOME_RAIL_LABELS: Record<HomeRailKey, string> = {
  'my-list': 'My List', 'keep-watching': 'Keep Watching', recommended: 'Recommended for you',
  'trending-movies': 'Trending Movies', 'recent-movies': 'Recent Movies', 'trending-tv': 'Trending TV',
  'recent-tv': 'Recent TV', 'trending-anime': 'Trending Anime', 'recent-anime': 'Recent Anime',
}

function homeRailKeys(value: unknown, fallback: HomeRailKey[]) {
  if (!Array.isArray(value)) return [...fallback]
  const allowed = new Set(HOME_RAIL_ORDER), unique = value.filter((key): key is HomeRailKey => typeof key === 'string' && allowed.has(key as HomeRailKey))
    .filter((key, index, values) => values.indexOf(key) === index)
  return [...unique, ...HOME_RAIL_ORDER.filter(key => !unique.includes(key))]
}

const DEFAULT_UI_PREFERENCES: NetWatchUiPreferences = {
  appearance: normalizeAppearance(DEFAULT_APPEARANCE) as AppearancePreferences,
  ...PLAYBACK_DEFAULTS,
  defaultQuality: 'all',
  subtitleLanguage: 'en',
  showStartupDetails: false,
  onClose: 'exit',
  startWithWindows: false,
  startMinimized: false,
  updateNotifications: false,
  keepWatchingEnabled: true,
  keepWatchingLimit: 5,
  flareSolverrEnabled: false,
  resourceProfile: 'standard',
  homeLayout: 'standard',
  homeRailOrder: [...HOME_RAIL_ORDER],
  hiddenHomeRails: [],
  trackedSeriesNotifications: false,
  alwaysSkipIntro: false,
  interfaceScale: 100,
  contrastMode: 'standard',
  reducedMotion: false,
  tvMode: false,
}

const STORAGE_KEY = 'netwatch-ui-preferences-v1'

export function loadUiPreferences(): NetWatchUiPreferences {
  if (typeof window === 'undefined') return DEFAULT_UI_PREFERENCES
  try {
    const raw = profileStorage.getItem(STORAGE_KEY)
    if (!raw) return DEFAULT_UI_PREFERENCES
    const parsed = JSON.parse(raw)
    return {
      appearance: normalizeAppearance(parsed?.appearance) as AppearancePreferences,
      ...normalizePlaybackPreferences(parsed),
      defaultQuality: ['all', '2160p', '1080p', '720p'].includes(parsed?.defaultQuality)
        ? parsed.defaultQuality
        : DEFAULT_UI_PREFERENCES.defaultQuality,
      subtitleLanguage: typeof parsed?.subtitleLanguage === 'string' && parsed.subtitleLanguage
        ? parsed.subtitleLanguage
        : DEFAULT_UI_PREFERENCES.subtitleLanguage,
      showStartupDetails: Boolean(parsed?.showStartupDetails),
      onClose: parsed?.onClose === 'minimize-to-tray' ? 'minimize-to-tray' : 'exit',
      startWithWindows: Boolean(parsed?.startWithWindows),
      startMinimized: Boolean(parsed?.startMinimized),
      updateNotifications: Boolean(parsed?.updateNotifications),
      keepWatchingEnabled: typeof parsed?.keepWatchingEnabled === 'boolean' ? parsed.keepWatchingEnabled : true,
      keepWatchingLimit: Number.isInteger(parsed?.keepWatchingLimit) && parsed.keepWatchingLimit >= 1 && parsed.keepWatchingLimit <= 20
        ? parsed.keepWatchingLimit
        : 5,
      flareSolverrEnabled: Boolean(parsed?.flareSolverrEnabled),
      resourceProfile: parsed?.resourceProfile === 'reduced' ? 'reduced' : 'standard',
      homeLayout: parsed?.homeLayout === 'cinematic' ? 'cinematic' : 'standard',
      homeRailOrder: homeRailKeys(parsed?.homeRailOrder, HOME_RAIL_ORDER),
      hiddenHomeRails: homeRailKeys(parsed?.hiddenHomeRails, []).filter(key => Array.isArray(parsed?.hiddenHomeRails) && parsed.hiddenHomeRails.includes(key)),
      trackedSeriesNotifications: parsed?.trackedSeriesNotifications === true,
      alwaysSkipIntro: parsed?.alwaysSkipIntro === true,
      interfaceScale: [100, 115, 130].includes(parsed?.interfaceScale) ? parsed.interfaceScale : 100,
      contrastMode: parsed?.contrastMode === 'strong' ? 'strong' : 'standard',
      reducedMotion: parsed?.reducedMotion === true,
      tvMode: parsed?.tvMode === true,
    }
  } catch {
    return DEFAULT_UI_PREFERENCES
  }
}

export function saveUiPreferences(next: NetWatchUiPreferences) {
  if (typeof window === 'undefined') return
  try {
    profileStorage.setItem(STORAGE_KEY, JSON.stringify(next))
  } catch {
    // UI preferences are best-effort. Playback must never depend on localStorage.
  }
}
