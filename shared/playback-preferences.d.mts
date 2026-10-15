export interface PlaybackPreferences {
  autoPlayNextEpisode: boolean
  preferredAudioLanguage: string
  preferredSubtitleLanguage: string
  playbackSpeed: number
  playbackAspect: 'fit' | 'fill' | 'original' | '16:9' | '4:3'
  subtitleScale: number
  subtitleBackdrop: boolean
  subtitleContrast: 'standard' | 'high' | 'yellow'
  overrideSubtitleStyles: boolean
}
export const PLAYBACK_DEFAULTS: Readonly<PlaybackPreferences>
export const PLAYBACK_LANGUAGES: ReadonlyArray<readonly [string, string]>
export const PLAYBACK_SPEEDS: readonly number[]
export const PLAYBACK_ASPECTS: readonly PlaybackPreferences['playbackAspect'][]
export function normalizePlaybackPreferences(value?: unknown, fallback?: PlaybackPreferences): PlaybackPreferences
