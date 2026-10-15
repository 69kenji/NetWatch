import { PLAYBACK_ASPECTS, PLAYBACK_LANGUAGES, PLAYBACK_SPEEDS } from '../../shared/playback-preferences.mjs'
import type { PlaybackPreferences } from '../types/playback'

export function PlaybackSettings({ preferences, onChange }: {
  preferences: PlaybackPreferences
  onChange: (patch: Partial<PlaybackPreferences>) => void
}) {
  const options: { key: keyof PlaybackPreferences; label: string; values: readonly (readonly [string | number | boolean, string])[] }[] = [
    { key: 'autoPlayNextEpisode', label: 'Autoplay next episode', values: [[false, 'Off'], [true, 'On · 10-second countdown']] },
    { key: 'preferredAudioLanguage', label: 'Audio language', values: [['auto', 'File default'], ...PLAYBACK_LANGUAGES] },
    { key: 'preferredSubtitleLanguage', label: 'Subtitle language', values: [['auto', 'File default'], ['none', 'Off'], ...PLAYBACK_LANGUAGES] },
    { key: 'playbackSpeed', label: 'Playback speed', values: PLAYBACK_SPEEDS.map(value => [value, `${value}×`]) },
    { key: 'playbackAspect', label: 'Video size', values: PLAYBACK_ASPECTS.map(value => [value, value === 'fit' ? 'Fit' : value === 'fill' ? 'Fill' : value === 'original' ? 'Original size' : value]) },
    { key: 'subtitleScale', label: 'Subtitle size', values: [0.75, 1, 1.25, 1.5, 2].map(value => [value, `${value * 100}%`]) },
    { key: 'subtitleBackdrop', label: 'Subtitle backdrop', values: [[false, 'Off'], [true, 'On']] },
    { key: 'subtitleContrast', label: 'Subtitle contrast', values: [['standard', 'Standard'], ['high', 'High contrast'], ['yellow', 'Yellow']] },
    { key: 'overrideSubtitleStyles', label: 'Embedded subtitle styling', values: [[false, 'Preserve'], [true, 'Override']] },
  ]
  return <>{options.map(({ key, label, values }) => <section className="nw-settings-card nw-settings-card--compact" key={key}>
    <div className="nw-settings-card__copy"><strong>{label}</strong>
      {key === 'overrideSubtitleStyles' && <span>Override can change positioned signs and styled anime subtitles.</span>}
    </div>
    <select className="nw-settings-select" aria-label={label} value={String(preferences[key])}
      onChange={event => {
        const selected = values.find(([value]) => String(value) === event.target.value)
        if (selected) onChange({ [key]: selected[0] })
      }}>
      {values.map(([value, title]) => <option key={String(value)} value={String(value)}>{title}</option>)}
    </select>
  </section>)}</>
}
