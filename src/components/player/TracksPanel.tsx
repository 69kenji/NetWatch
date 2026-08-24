import { useEffect, useMemo, useState } from 'react'
import { motion } from 'framer-motion'
import { Check, Download, Minus, Plus, RefreshCircle, SoundHigh, WarningTriangle, Xmark } from 'iconoir-react'
import { api } from '../../utils/api'
import { loadUiPreferences, saveUiPreferences } from '../../utils/preferences'
import { useAppStore } from '../../store'
import type { MediaItem, Subtitle } from '../../store'

interface Props {
  mediaItem: MediaItem | null
  mediaTitle?: string | null
  filePath?: string | null
  tracks?: NativePlayerTrack[]
  activeSubtitleTrack?: number | string | null
  activeAudioTrack?: number | string | null
  switchingAudioTrack?: number | string | null
  onSelectAudio: (id: number | string) => void | Promise<void>
  onSyncFeedback?: (ms: number) => void
  onClose: () => void
}

type ProviderState = {
  status?: string
  connected?: boolean
  authenticated?: boolean
  error?: string
  count?: number
}

type ProviderMap = {
  opensubtitles?: ProviderState
  subdl?: ProviderState
}

const LANGUAGES = [
  ['en', 'English'], ['es', 'Spanish'], ['fr', 'French'], ['de', 'German'],
  ['it', 'Italian'], ['pt', 'Portuguese'], ['ru', 'Russian'], ['ja', 'Japanese'],
  ['ko', 'Korean'], ['zh', 'Chinese'], ['ar', 'Arabic'], ['nl', 'Dutch'],
  ['pl', 'Polish'], ['tr', 'Turkish'], ['sv', 'Swedish'], ['no', 'Norwegian'],
] as const

function getErrorMessage(error: unknown): string {
  const detail = (error as any)?.response?.data?.detail
  if (typeof detail === 'string') return detail
  if (detail?.error) return detail.error
  if (error instanceof Error && error.message) return error.message
  return String(error || 'Subtitle request failed')
}

function basename(value?: string | null): string {
  if (!value) return ''
  const normalized = value.replace(/\\/g, '/')
  return normalized.slice(normalized.lastIndexOf('/') + 1)
}

function providerLabel(provider: string): string {
  return provider === 'opensubtitles' ? 'OpenSubtitles' : provider === 'subdl' ? 'SubDL' : provider
}

function compactNumber(value?: number): string | null {
  if (!value || value <= 0) return null
  return new Intl.NumberFormat('en', { notation: 'compact', maximumFractionDigits: 1 }).format(value)
}

function languageLabel(code: string) {
  return LANGUAGES.find(([value]) => value.toLowerCase() === code.toLowerCase())?.[1] || code.toUpperCase()
}

function formatDelay(ms: number) {
  if (!ms) return '0.0 s'
  return `${ms > 0 ? '+' : '−'}${Math.abs(ms / 1000).toFixed(1)} s`
}

export function TracksPanel({ mediaItem, mediaTitle, filePath, tracks = [], activeSubtitleTrack = null, activeAudioTrack = null, switchingAudioTrack = null, onSelectAudio, onSyncFeedback, onClose }: Props) {
  const { player, updatePlayer } = useAppStore()
  const [subtitles, setSubtitles] = useState<Subtitle[]>([])
  const [providers, setProviders] = useState<ProviderMap>({})
  const [loading, setLoading] = useState(false)
  const [loadingId, setLoadingId] = useState<string | null>(null)
  const [selectedLang, setSelectedLang] = useState(() => loadUiPreferences().subtitleLanguage)
  const [error, setError] = useState<string | null>(null)

  const sourceFileName = useMemo(() => basename(filePath), [filePath])
  const searchTitle = mediaItem?.title || mediaTitle || sourceFileName || null
  const canSearch = Boolean(mediaItem?.imdb_id || sourceFileName || searchTitle)
  const delay = player.subtitleDelay || 0
  const audioTracks = tracks.filter(track => track.type === 'audio' && track.id != null)
  const embeddedTracks = tracks.filter(track => track.type === 'sub' && track.id != null && !track.external)

  useEffect(() => {
    let mounted = true
    void api.get('/api/subtitles/providers')
      .then(({ data }) => {
        if (!mounted) return
        setProviders({ opensubtitles: data.opensubtitles, subdl: data.subdl })
      })
      .catch(() => {})
    return () => { mounted = false }
  }, [])

  useEffect(() => {
    if (!canSearch) return
    let cancelled = false

    const fetchSubtitles = async () => {
      setLoading(true)
      setError(null)
      try {
        const { data } = await api.get('/api/subtitles/search', {
          params: {
            imdb_id: mediaItem?.imdb_id || undefined,
            query: searchTitle || undefined,
            file_name: sourceFileName || undefined,
            season: mediaItem?.season || undefined,
            episode: mediaItem?.episode || undefined,
            languages: selectedLang,
          },
        })
        if (cancelled) return
        setSubtitles(Array.isArray(data.results) ? data.results : [])
        if (data.providers) setProviders(data.providers)
      } catch (requestError) {
        if (cancelled) return
        setSubtitles([])
        setError(getErrorMessage(requestError))
      } finally {
        if (!cancelled) setLoading(false)
      }
    }

    void fetchSubtitles()
    return () => { cancelled = true }
  }, [canSearch, mediaItem?.imdb_id, mediaItem?.season, mediaItem?.episode, searchTitle, selectedLang, sourceFileName])

  const changeLanguage = (language: string) => {
    setSelectedLang(language)
    const current = loadUiPreferences()
    saveUiPreferences({ ...current, subtitleLanguage: language })
  }

  const loadSubtitle = async (sub: Subtitle) => {
    if (loadingId) return
    setLoadingId(sub.id)
    setError(null)
    let token: string | null = null

    try {
      const { data } = await api.post('/api/subtitles/download', {
        subtitle_id: sub.id,
        source: sub.source,
        download_ref: sub.download_ref,
        format: sub.format,
        file_name: sub.file_name || undefined,
      })
      token = data.token
      await window.electron?.player.command({
        type: 'loadSubtitle',
        path: data.url,
        token: data.token,
        title: sub.name,
        language: sub.language,
      })
      updatePlayer({
        subtitlePath: data.url,
        subtitleToken: data.token,
        subtitleId: sub.id,
        subtitleName: sub.name,
        subtitleSource: sub.source,
      })
    } catch (requestError) {
      if (token) void api.delete(`/api/subtitles/file/${encodeURIComponent(token)}`).catch(() => {})
      setError(getErrorMessage(requestError))
    } finally {
      setLoadingId(null)
    }
  }

  const disableSubtitles = async () => {
    try {
      await window.electron?.player.command({ type: 'disableSubtitles' })
      updatePlayer({
        subtitlePath: null,
        subtitleToken: null,
        subtitleId: null,
        subtitleName: null,
        subtitleSource: null,
      })
    } catch (requestError) {
      setError(getErrorMessage(requestError))
    }
  }

  const selectEmbeddedTrack = async (track: NativePlayerTrack) => {
    if (track.id == null) return
    try {
      // Release an external cached subtitle first, then select the embedded track.
      if (player.subtitleToken) await window.electron?.player.command({ type: 'disableSubtitles' })
      await window.electron?.player.command({ type: 'setSubtitleTrack', id: track.id })
      updatePlayer({
        subtitlePath: null,
        subtitleToken: null,
        subtitleId: `track:${String(track.id)}`,
        subtitleName: track.title || track.lang || 'Embedded subtitle',
        subtitleSource: 'embedded',
      })
    } catch (requestError) {
      setError(getErrorMessage(requestError))
    }
  }

  const applyDelay = async (ms: number) => {
    const clamped = Math.max(-10_000, Math.min(10_000, ms))
    try {
      await window.electron?.player.command({ type: 'setSubtitleDelay', seconds: clamped / 1000 })
      updatePlayer({ subtitleDelay: clamped })
      onSyncFeedback?.(clamped)
    } catch (requestError) {
      setError(getErrorMessage(requestError))
    }
  }

  return (
    <motion.aside
      className="player-side-panel player-floating-panel subtitle-panel player-tracks-panel"
      initial={{ opacity: 0, y: 12, scale: 0.985 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      exit={{ opacity: 0, y: 8, scale: 0.99 }}
      transition={{ duration: 0.14, ease: 'easeOut' }}
      onClick={event => event.stopPropagation()}
    >
      <header className="player-side-panel__header">
        <div className="player-side-panel__heading">
          <strong>Tracks</strong>
          <span title={sourceFileName || searchTitle || undefined}>{sourceFileName || searchTitle || 'Current video'}</span>
        </div>
        <button className="btn btn-ghost btn-icon" onClick={onClose} title="Close tracks" aria-label="Close tracks">
          <Xmark width={18} height={18} />
        </button>
      </header>

      <div className="player-side-panel__body subtitle-panel__body">
        <section className="player-track-audio-section">
          <div className="subtitle-section-heading">
            <div>
              <strong>Audio</strong>
            </div>
            <SoundHigh width={15} height={15} />
          </div>
          <div className="player-option-list">
            {audioTracks.length === 0 ? (
              <div className="player-panel-empty">Default audio track</div>
            ) : audioTracks.map((track, index) => {
              const active = String(activeAudioTrack) === String(track.id)
              const switching = switchingAudioTrack != null && String(switchingAudioTrack) === String(track.id)
              const label = track.title || track.lang || `Audio ${index + 1}`
              return (
                <button
                  key={String(track.id)}
                  className={`player-option-row ${active ? 'is-active' : ''}`}
                  onClick={() => void onSelectAudio(track.id!)}
                  disabled={switchingAudioTrack != null}
                >
                  <span className="player-option-row__copy">
                    <strong>{label}</strong>
                    <span>{[track.lang, track.codec].filter(Boolean).join(' · ') || 'Audio'}</span>
                  </span>
                  {switching ? <RefreshCircle width={17} height={17} className="nw-spin" /> : active && <Check width={17} height={17} />}
                </button>
              )
            })}
          </div>
        </section>

        <section className="subtitle-quick-settings">
          <label className="subtitle-language-row" htmlFor="subtitle-language">
            <span>
              <strong>Language</strong>
              
            </span>
            <select id="subtitle-language" value={selectedLang} onChange={event => changeLanguage(event.target.value)}>
              {LANGUAGES.map(([code, name]) => <option key={code} value={code}>{name}</option>)}
            </select>
          </label>

          <div className="subtitle-sync-row">
            <span>
              <strong>Sync</strong>
              
            </span>
            <div className="subtitle-sync-control">
              <button onClick={() => void applyDelay(delay - 100)} aria-label="Show subtitles 100 milliseconds earlier"><Minus width={17} height={17} /></button>
              <button className={`subtitle-sync-value ${delay ? 'is-adjusted' : ''}`} onClick={() => void applyDelay(0)} title={delay ? 'Reset subtitle sync' : 'Subtitles are synced'}>
                {formatDelay(delay)}
              </button>
              <button onClick={() => void applyDelay(delay + 100)} aria-label="Show subtitles 100 milliseconds later"><Plus width={17} height={17} /></button>
            </div>
          </div>
        </section>

        <section className="subtitle-track-section">
          <div className="subtitle-section-heading">
            <div>
              <strong>Subtitles</strong>
            </div>
          </div>

          <button className={`subtitle-track-row ${!player.subtitleId && (activeSubtitleTrack == null || String(activeSubtitleTrack) === 'no') ? 'is-active' : ''}`} onClick={() => void disableSubtitles()}>
            <span className="subtitle-track-row__copy"><strong>Off</strong></span>
            {!player.subtitleId && <Check width={17} height={17} />}
          </button>

          {embeddedTracks.map((track, index) => {
            const active = String(activeSubtitleTrack) === String(track.id) && !player.subtitleToken
            return (
              <button key={String(track.id)} className={`subtitle-track-row ${active ? 'is-active' : ''}`} onClick={() => void selectEmbeddedTrack(track)}>
                <span className="subtitle-track-row__copy">
                  <strong>{track.title || track.lang || `Embedded ${index + 1}`}</strong>
                  <small>{[track.lang, track.codec].filter(Boolean).join(' · ') || 'Embedded subtitle'}</small>
                </span>
                {active && <Check width={17} height={17} />}
              </button>
            )
          })}
        </section>

        <section className="subtitle-results-section">
          <div className="subtitle-section-heading">
            <div>
              <strong>Online</strong>
            </div>
            <div className="subtitle-provider-pills" aria-label="Subtitle providers">
              {(['opensubtitles', 'subdl'] as const).map(provider => {
                const state = providers[provider]
                return (
                  <span key={provider} className={state?.connected ? 'is-ready' : state?.error ? 'is-error' : ''} title={state?.error || providerLabel(provider)}>
                    {provider === 'opensubtitles' ? 'OS' : 'SubDL'}
                  </span>
                )
              })}
              {loading && <RefreshCircle width={14} height={14} className="subtitle-search-spinner" />}
            </div>
          </div>

          {error && (
            <div className="subtitle-panel__error">
              <WarningTriangle width={16} height={16} />
              <span>{error}</span>
            </div>
          )}

          {!canSearch && !error && <div className="subtitle-panel__empty">Waiting for media…</div>}

          {loading && subtitles.length === 0 && (
            <div className="subtitle-result-skeletons" aria-label="Searching subtitles">
              {Array.from({ length: 5 }).map((_, index) => <span key={index} />)}
            </div>
          )}

          {!loading && canSearch && subtitles.length === 0 && !error && (
            <div className="subtitle-panel__empty">No {languageLabel(selectedLang)} subtitles.</div>
          )}

          <div className="subtitle-results-list">
            {subtitles.map(sub => {
              const active = player.subtitleId === sub.id
              const downloading = loadingId === sub.id
              const downloads = compactNumber(sub.downloads)
              const details = [
                providerLabel(sub.source),
                sub.format?.toUpperCase(),
                sub.fps ? `${sub.fps} fps` : null,
                downloads ? `${downloads} downloads` : null,
              ].filter(Boolean).join(' · ')

              return (
                <button
                  key={sub.id}
                  className={`subtitle-result-row ${active ? 'is-active' : ''}`}
                  onClick={() => void loadSubtitle(sub)}
                  disabled={Boolean(loadingId)}
                  title={sub.name}
                >
                  <span className="subtitle-result-row__language">{sub.language?.slice(0, 2).toUpperCase() || selectedLang.toUpperCase()}</span>
                  <span className="subtitle-result-row__copy">
                    <strong>{sub.name}</strong>
                    <small>{details}</small>
                  </span>
                  {sub.hearing_impaired && <span className="subtitle-result-row__badge">HI</span>}
                  <span className="subtitle-result-row__action">
                    {downloading ? <RefreshCircle className="subtitle-search-spinner" width={17} height={17} /> : active ? <Check width={17} height={17} /> : <Download width={17} height={17} />}
                  </span>
                </button>
              )
            })}
          </div>
        </section>
      </div>
    </motion.aside>
  )
}
