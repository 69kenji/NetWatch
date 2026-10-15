export const PLAYBACK_DEFAULTS = Object.freeze({
  autoPlayNextEpisode: false,
  preferredAudioLanguage: 'auto',
  preferredSubtitleLanguage: 'auto',
  playbackSpeed: 1,
  playbackAspect: 'fit',
  subtitleScale: 1,
  subtitleBackdrop: false,
  subtitleContrast: 'standard',
  overrideSubtitleStyles: false,
})

export const PLAYBACK_LANGUAGES = Object.freeze([
  ['en', 'English'], ['ar', 'Arabic'], ['zh', 'Chinese'], ['nl', 'Dutch'],
  ['fr', 'French'], ['de', 'German'], ['el', 'Greek'], ['it', 'Italian'],
  ['ja', 'Japanese'], ['ko', 'Korean'], ['no', 'Norwegian'], ['pl', 'Polish'],
  ['pt', 'Portuguese'], ['ru', 'Russian'], ['es', 'Spanish'], ['sv', 'Swedish'], ['tr', 'Turkish'],
])
export const PLAYBACK_SPEEDS = Object.freeze([0.5, 0.75, 1, 1.25, 1.5, 1.75, 2])
export const PLAYBACK_ASPECTS = Object.freeze(['fit', 'fill', 'original', '16:9', '4:3'])

export function normalizePlaybackPreferences(value = {}, fallback = PLAYBACK_DEFAULTS) {
  const languages = ['auto', ...PLAYBACK_LANGUAGES.map(([code]) => code)]
  const choices = {
    preferredAudioLanguage: languages,
    preferredSubtitleLanguage: [...languages, 'none'],
    playbackSpeed: PLAYBACK_SPEEDS,
    playbackAspect: PLAYBACK_ASPECTS,
    subtitleScale: [0.75, 1, 1.25, 1.5, 2],
    subtitleContrast: ['standard', 'high', 'yellow'],
  }
  return Object.fromEntries(Object.entries(PLAYBACK_DEFAULTS).map(([key, defaultValue]) => {
    const candidate = value?.[key]
    const valid = typeof defaultValue === 'boolean' ? typeof candidate === 'boolean' : choices[key].includes(candidate)
    return [key, valid ? candidate : fallback[key] ?? defaultValue]
  }))
}
