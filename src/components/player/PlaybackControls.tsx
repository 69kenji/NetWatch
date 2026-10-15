import { useEffect, useRef, useState } from 'react'
import { PLAYBACK_ASPECTS, PLAYBACK_DEFAULTS, PLAYBACK_SPEEDS } from '../../../shared/playback-preferences.mjs'
import type { PlaybackPreferences } from '../../types/playback'

export function PlaybackControls({ onError }: { onError: (message: string) => void }) {
  const [preferences, setPreferences] = useState<PlaybackPreferences>({ ...PLAYBACK_DEFAULTS })
  const [busy, setBusy] = useState(false)
  const pending = useRef(false)
  const bridge = window.electron?.player
  useEffect(() => {
    let active = true
    void bridge?.getPreferences().then(value => { if (active) setPreferences(value) }).catch(() => {})
    return () => { active = false }
  }, [bridge])
  const update = async (patch: Partial<PlaybackPreferences>) => {
    if (!bridge || pending.current) return
    pending.current = true
    setBusy(true)
    try { setPreferences(await bridge.updatePreferences(patch)) }
    catch { onError('Could not apply playback preference') }
    finally { pending.current = false; setBusy(false) }
  }
  const nextSpeed = PLAYBACK_SPEEDS[(PLAYBACK_SPEEDS.indexOf(preferences.playbackSpeed) + 1) % PLAYBACK_SPEEDS.length]
  const nextAspect = PLAYBACK_ASPECTS[(PLAYBACK_ASPECTS.indexOf(preferences.playbackAspect) + 1) % PLAYBACK_ASPECTS.length]
  const aspectLabel = (value: string) => value === 'fit' ? 'Fit' : value === 'fill' ? 'Fill' : value === 'original' ? 'Original' : value
  return <div className="player-playback-preferences">
    <button type="button" aria-label={`Playback speed: ${preferences.playbackSpeed}×. Change to ${nextSpeed}×`}
      title={`Playback speed · next ${nextSpeed}×`} disabled={busy} onClick={() => void update({ playbackSpeed: nextSpeed })}>{preferences.playbackSpeed}×</button>
    <button type="button" aria-label={`Video size: ${aspectLabel(preferences.playbackAspect)}. Change to ${aspectLabel(nextAspect)}`}
      title={`Video size · next ${aspectLabel(nextAspect)}`} disabled={busy} onClick={() => void update({ playbackAspect: nextAspect })}>{aspectLabel(preferences.playbackAspect)}</button>
  </div>
}
