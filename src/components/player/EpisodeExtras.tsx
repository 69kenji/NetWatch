import { useCallback, useEffect, useRef, useState } from 'react'
import type { CSSProperties } from 'react'
import { NavArrowRight } from 'iconoir-react'
import type { TmdbEpisode } from '../../types/metadata'
import { NextEpisodeButton } from './NextEpisodeButton'

interface Props {
  session: NativePlayerSession
  state: NativePlayerState | null
  blocked: boolean
  menusOpen: boolean
}

// Mounted once per playback session, not once per torrent telemetry update.
export function EpisodeExtras({ session, state, blocked, menusOpen }: Props) {
  const bridge = window.electron?.player
  const [info, setInfo] = useState<EpisodePlaybackInfo | null>(null)
  const [next, setNext] = useState<TmdbEpisode | null>(null)
  const [guidePhase, setGuidePhase] = useState<'waiting' | 'showing' | 'exiting' | 'done'>('waiting')
  const [guide, setGuide] = useState<EpisodePlaybackInfo | null>(null)
  const [skipping, setSkipping] = useState(false)
  const [advancing, setAdvancing] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const autoAttempted = useRef(false)
  const skipPending = useRef(false)
  const nextPending = useRef(false)
  const [autoplay, setAutoplay] = useState(false)
  const [autoplayCancelled, setAutoplayCancelled] = useState(false)
  const [countdown, setCountdown] = useState(10)
  const autoplayAttempted = useRef(false)
  const mounted = useRef(true)

  useEffect(() => {
    mounted.current = true
    if (bridge) {
      void bridge.getPreferences?.().then(value => {
        if (mounted.current) setAutoplay(value.autoPlayNextEpisode)
      }).catch(() => {})
      void bridge.getNextEpisode(session.openedAt).then(value => {
        if (mounted.current) setNext(value)
      }).catch(() => {})
    }
    return () => { mounted.current = false }
  }, [bridge, session.openedAt])

  const durationKey = Math.round(state?.duration || 0)
  const chapterKey = JSON.stringify(state?.chapters || [])
  useEffect(() => {
    let current = true
    if (bridge) void bridge.getEpisodeInfo(session.openedAt).then(value => {
      if (current) setInfo(value)
    }).catch(() => {})
    // Duration and chapters arrive after the player opens. An earlier response
    // must not overwrite the timings for the actual file once it is loaded.
    return () => { current = false }
  }, [bridge, session.openedAt, durationKey, chapterKey])

  const guideRows = [
    ...(guide?.genres.length ? [{ key: 'genres', content: <>{guide.genres.join(' · ')}</> }] : []),
    ...(guide?.rating ? [{ key: 'rating', content: <>{guide.rating.label} <small>({guide.rating.country})</small></> }] : []),
    ...(guide?.guidance.length ? [
      { key: 'scope', content: <small className="player-episode-guide__scope">Series guidance</small> },
      ...guide.guidance.map(row => ({ key: row.label, content: <>{row.label} <small>{row.severity}</small></> })),
    ] : []),
  ]
  useEffect(() => {
    if (guidePhase === 'waiting') {
      if (blocked || menusOpen || !state?.ready || state.seeking || state.seekBuffering || state.pausedForCache || !info) return
      if (!(info.genres.length || info.rating || info.guidance.length)) return
      setGuide(info)
      setGuidePhase('showing')
    } else if (guidePhase !== 'done' && (blocked || menusOpen)) {
      // A buffer/menu may end the presentation, but must never restart it.
      setGuidePhase('done')
    }
  }, [guidePhase, blocked, menusOpen, state?.ready, state?.seeking, state?.seekBuffering, state?.pausedForCache, info])

  useEffect(() => {
    if (guidePhase !== 'showing') return
    const timer = window.setTimeout(() => setGuidePhase('exiting'), 5400 + guideRows.length * 160)
    return () => window.clearTimeout(timer)
  }, [guidePhase, guideRows.length])

  useEffect(() => {
    if (guidePhase !== 'exiting') return
    const timer = window.setTimeout(() => setGuidePhase('done'), guideRows.length * 110 + 400)
    return () => window.clearTimeout(timer)
  }, [guidePhase, guideRows.length])

  const intro = info?.intro
  const inIntro = Boolean(intro && state && !blocked && state.ready && !state.seeking && !state.seekBuffering && !state.pausedForCache &&
    Number.isFinite(intro.start) && Number.isFinite(intro.end) &&
    intro.start >= 0 && intro.end > intro.start && intro.end - intro.start <= 300 &&
    intro.end < state.duration && state.position >= intro.start && state.position < intro.end)

  const skip = useCallback(async () => {
    if (!bridge || skipPending.current) return
    skipPending.current = true
    autoAttempted.current = true
    setSkipping(true)
    setError(null)
    try {
      await bridge.skipIntro(session.openedAt)
    } catch {
      if (mounted.current) setError('Could not skip intro. Try again.')
    } finally {
      skipPending.current = false
      if (mounted.current) setSkipping(false)
    }
  }, [bridge, session.openedAt])

  useEffect(() => {
    if (info?.alwaysSkipIntro && inIntro && !state?.paused && !autoAttempted.current) void skip()
  }, [info?.alwaysSkipIntro, inIntro, state?.paused, skip])

  const advance = useCallback(async () => {
    if (!bridge || nextPending.current) return
    nextPending.current = true
    autoplayAttempted.current = true
    setAdvancing(true)
    setError(null)
    try {
      await bridge.playNextEpisode(session.openedAt)
    } catch (failure) {
      const message = failure && typeof failure === 'object' && 'message' in failure && typeof failure.message === 'string'
        ? failure.message : ''
      if (mounted.current) setError(message
        ? message.replace(/^Error invoking remote method '[^']+': (?:Error: )?/, '').slice(0, 240)
        : 'Next episode could not start. Try again.')
    } finally {
      nextPending.current = false
      if (mounted.current) setAdvancing(false)
    }
  }, [bridge, session.openedAt])

  const outro = info?.outro
  const hasOutro = Boolean(outro && state && Number.isFinite(outro.start) && Number.isFinite(outro.end) &&
    outro.start >= state.duration / 2 && outro.end > outro.start && outro.end <= state.duration && outro.end - outro.start <= 600)
  const nearEnd = Boolean(state && state.duration > 0 &&
    (state.eofReached || state.status === 'ended' || (hasOutro
      ? state.position >= outro!.start
      : state.duration - state.position <= Math.min(120, state.duration * 0.1))))

  const canAutoplay = autoplay && !autoplayCancelled && !autoplayAttempted.current && nearEnd && next &&
    !blocked && !menusOpen && !state?.seeking && !state?.seekBuffering && !state?.pausedForCache &&
    (!state?.paused || state?.eofReached || state?.status === 'ended') && !advancing && !skipping && !error
  useEffect(() => {
    if (!canAutoplay) { setCountdown(10); return }
    const timer = window.setInterval(() => setCountdown(value => Math.max(0, value - 1)), 1000)
    return () => window.clearInterval(timer)
  }, [Boolean(canAutoplay)])
  useEffect(() => {
    if (canAutoplay && countdown === 0) void advance()
  }, [Boolean(canAutoplay), countdown, advance])

  return <>
    {(guidePhase === 'showing' || guidePhase === 'exiting') && !blocked && !menusOpen && (
      <aside className={`player-episode-guide${guidePhase === 'exiting' ? ' player-episode-guide--exit' : ''}`}
        style={{ '--row-count': guideRows.length } as CSSProperties} aria-label="Series information">
        {guideRows.map((row, index) => <span className="player-episode-guide__row" key={row.key}
          style={{ '--row-index': index } as CSSProperties}>{row.content}</span>)}
      </aside>
    )}
    {!blocked && !menusOpen && (inIntro || (nearEnd && next) || advancing || error) && (
      <div className="player-episode-actions" onClick={event => event.stopPropagation()}>
        {error && <span className="player-episode-actions__error" role="status">{error}</span>}
        {inIntro && <button className="player-episode-action" disabled={skipping || advancing} onClick={() => void skip()}>
          {skipping ? 'Skipping…' : 'Skip Intro'} <NavArrowRight width={18} height={18} />
        </button>}
        {((nearEnd && next) || advancing) && <NextEpisodeButton
          disabled={advancing || skipping} onClick={() => void advance()}
          autoplay={Boolean(canAutoplay)} countdown={countdown}
          title={next ? `S${next.season_number}E${next.episode_number} · ${next.name}` : undefined}
          label={advancing ? 'Finding next episode…' : canAutoplay ? `Next Episode · ${countdown}` : 'Next Episode'}
        />}
        {canAutoplay && <button className="player-episode-action" onClick={() => setAutoplayCancelled(true)} aria-label="Cancel autoplay">Cancel</button>}
      </div>
    )}
  </>
}
