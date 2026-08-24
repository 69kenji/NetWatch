import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react'
import { motion } from 'framer-motion'
import {
  Group,
  HardDrive,
  NavArrowLeft,
  Play,
  RefreshCircle,
  WarningTriangle,
} from 'iconoir-react'
import type {
  EpisodeStreamOptions,
  TmdbEpisode,
  TmdbSeasonDetails,
  TmdbSeriesDetails,
  TmdbSeriesSummary,
} from '../types/metadata'
import { assertReleaseReferences, formatBytes, sortResults, type QualityFilter, type ResultSort, type TorrentSearchResult } from '../types/torrents'
import { BACKEND_BASE_URL } from '../utils/api'

interface SeriesDetailsViewProps {
  seedSeries: TmdbSeriesSummary
  details: TmdbSeriesDetails | null
  loading: boolean
  error: string | null
  openingSource: string | null
  qualityFilter: QualityFilter
  sortMode: ResultSort
  anime?: boolean
  onQualityFilter: (value: QualityFilter) => void
  onSortMode: (value: ResultSort) => void
  onBack: () => void
  onRetry: () => void
  onPlay: (result: TorrentSearchResult, series: TmdbSeriesDetails, episode: TmdbEpisode) => void
}

function getErrorMessage(error: unknown) {
  if (error instanceof Error && error.message) return error.message
  return String(error || 'Request failed')
}

async function readJsonResponse(response: Response) {
  const text = await response.text()
  let payload: any = null
  try { payload = text ? JSON.parse(text) : null } catch (_) {}
  if (!response.ok) {
    const detail = payload?.detail
    const message = typeof detail === 'string'
      ? detail
      : detail?.error || detail?.message || `Request failed with HTTP ${response.status}`
    throw new Error(message)
  }
  return payload
}

async function fetchSeason(seriesId: number, seasonNumber: number): Promise<TmdbSeasonDetails> {
  const response = await fetch(
    `${BACKEND_BASE_URL}/api/metadata/series/${seriesId}/seasons/${seasonNumber}`,
  )
  return await readJsonResponse(response) as TmdbSeasonDetails
}

async function fetchEpisodeStreams(
  seriesId: number,
  episode: TmdbEpisode,
  anime: boolean,
): Promise<EpisodeStreamOptions> {
  const params = new URLSearchParams({ min_seeders: '1', anime: anime ? 'true' : 'false' })
  const response = await fetch(
    `${BACKEND_BASE_URL}/api/metadata/series/${seriesId}/episodes/${episode.season_number}/${episode.episode_number}/stream-options?${params}`,
  )
  const payload = await readJsonResponse(response) as EpisodeStreamOptions
  assertReleaseReferences(payload.results)
  return payload
}

function releaseSource(result: TorrentSearchResult) {
  return result.release_ref || ''
}

function episodeCode(episode: TmdbEpisode) {
  return `S${String(episode.season_number).padStart(2, '0')}E${String(episode.episode_number).padStart(2, '0')}`
}

function runtimeLabel(minutes?: number | null) {
  return minutes && minutes > 0 ? `${minutes} min` : null
}

const EPISODE_RANGE_SIZE = 50

export function SeriesDetailsView({
  seedSeries,
  details,
  loading,
  error,
  openingSource,
  qualityFilter,
  sortMode,
  anime = false,
  onQualityFilter,
  onSortMode,
  onBack,
  onRetry,
  onPlay,
}: SeriesDetailsViewProps) {
  const series = details || seedSeries
  const [seasonNumber, setSeasonNumber] = useState<number | null>(null)
  const [seasonData, setSeasonData] = useState<TmdbSeasonDetails | null>(null)
  const [seasonLoading, setSeasonLoading] = useState(false)
  const [seasonError, setSeasonError] = useState<string | null>(null)
  const [selectedEpisode, setSelectedEpisode] = useState<TmdbEpisode | null>(null)
  const [streamData, setStreamData] = useState<EpisodeStreamOptions | null>(null)
  const [streamLoading, setStreamLoading] = useState(false)
  const [streamError, setStreamError] = useState<string | null>(null)
  const [episodeRangeIndex, setEpisodeRangeIndex] = useState(0)
  const [episodeJump, setEpisodeJump] = useState('')
  const [episodeJumpInvalid, setEpisodeJumpInvalid] = useState(false)
  const [pendingJumpEpisode, setPendingJumpEpisode] = useState<number | null>(null)
  const seasonRequestId = useRef(0)
  const streamRequestId = useRef(0)
  const episodeGridRef = useRef<HTMLDivElement | null>(null)

  const seasons = useMemo(
    () => (details?.seasons || []).filter(season => season.season_number > 0 && season.episode_count > 0),
    [details],
  )

  useEffect(() => {
    if (!details || !seasons.length) return
    setSeasonNumber(current => current != null && seasons.some(item => item.season_number === current)
      ? current
      : seasons[0].season_number)
  }, [details, seasons])

  useEffect(() => {
    if (!details || seasonNumber == null) return
    const requestId = ++seasonRequestId.current
    setSeasonLoading(true)
    setSeasonError(null)
    setSeasonData(null)
    setSelectedEpisode(null)
    setStreamData(null)
    setStreamError(null)
    setEpisodeRangeIndex(0)
    setEpisodeJump('')
    setEpisodeJumpInvalid(false)
    setPendingJumpEpisode(null)

    void fetchSeason(details.id, seasonNumber)
      .then(next => {
        if (requestId === seasonRequestId.current) setSeasonData(next)
      })
      .catch(requestError => {
        if (requestId === seasonRequestId.current) setSeasonError(getErrorMessage(requestError))
      })
      .finally(() => {
        if (requestId === seasonRequestId.current) setSeasonLoading(false)
      })
  }, [details, seasonNumber])

  const selectEpisode = (episode: TmdbEpisode) => {
    if (!details) return
    const requestId = ++streamRequestId.current
    setSelectedEpisode(episode)
    setStreamLoading(true)
    setStreamError(null)
    setStreamData(null)

    void fetchEpisodeStreams(details.id, episode, anime || Boolean(details.is_anime))
      .then(next => {
        if (requestId === streamRequestId.current) setStreamData(next)
      })
      .catch(requestError => {
        if (requestId === streamRequestId.current) setStreamError(getErrorMessage(requestError))
      })
      .finally(() => {
        if (requestId === streamRequestId.current) setStreamLoading(false)
      })
  }

  const retryStreams = () => {
    if (selectedEpisode) selectEpisode(selectedEpisode)
  }

  const seasonEpisodes = seasonData?.episodes || []
  const usesEpisodeRanges = seasonEpisodes.length > EPISODE_RANGE_SIZE
  const episodeRanges = useMemo(() => {
    if (!usesEpisodeRanges) return []
    return Array.from({ length: Math.ceil(seasonEpisodes.length / EPISODE_RANGE_SIZE) }, (_, index) => {
      const start = index * EPISODE_RANGE_SIZE
      const rangeEpisodes = seasonEpisodes.slice(start, start + EPISODE_RANGE_SIZE)
      const first = rangeEpisodes[0]?.episode_number ?? start + 1
      const last = rangeEpisodes[rangeEpisodes.length - 1]?.episode_number ?? Math.min(start + EPISODE_RANGE_SIZE, seasonEpisodes.length)
      return { index, label: `Episodes ${first}–${last}` }
    })
  }, [seasonEpisodes, usesEpisodeRanges])

  const visibleEpisodes = usesEpisodeRanges
    ? seasonEpisodes.slice(episodeRangeIndex * EPISODE_RANGE_SIZE, (episodeRangeIndex + 1) * EPISODE_RANGE_SIZE)
    : seasonEpisodes

  const jumpToEpisode = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (!seasonData) return
    const requested = Number.parseInt(episodeJump.trim(), 10)
    const episodeIndex = Number.isInteger(requested)
      ? seasonEpisodes.findIndex(episode => episode.episode_number === requested)
      : -1
    if (episodeIndex < 0) {
      setEpisodeJumpInvalid(true)
      return
    }
    setEpisodeJumpInvalid(false)
    setEpisodeRangeIndex(Math.floor(episodeIndex / EPISODE_RANGE_SIZE))
    setPendingJumpEpisode(requested)
  }

  useEffect(() => {
    if (pendingJumpEpisode == null) return
    const frame = window.requestAnimationFrame(() => {
      const target = episodeGridRef.current?.querySelector<HTMLButtonElement>(
        `[data-episode-number="${pendingJumpEpisode}"]`,
      )
      if (!target) return
      target.focus({ preventScroll: true })
      target.scrollIntoView({ behavior: 'smooth', block: 'center' })
      setPendingJumpEpisode(null)
    })
    return () => window.cancelAnimationFrame(frame)
  }, [pendingJumpEpisode, episodeRangeIndex, seasonData])

  const releases = streamData?.results || []
  const filtered = qualityFilter === 'all'
    ? releases
    : releases.filter(result => result.resolution?.toLowerCase() === qualityFilter.toLowerCase())
  const visible = sortResults(filtered, sortMode)

  return (
    <motion.section
      className="nw-view nw-movie-view nw-series-view"
      key={`series-${series.id}`}
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      transition={{ duration: 0.2 }}
    >
      <div className="nw-movie-hero nw-series-hero">
        <div className="nw-movie-hero__backdrop" aria-hidden="true">
          {series.backdrop ? <img src={series.backdrop} alt="" draggable={false} /> : null}
        </div>
        <div className="nw-movie-hero__veil" aria-hidden="true" />

        <button className="nw-movie-back" onClick={onBack} aria-label="Back to catalog results">
          <NavArrowLeft width={20} height={20} />
          <span>Back</span>
        </button>

        <div className="nw-movie-hero__content">
          <div className="nw-movie-hero__poster">
            {series.poster ? <img src={series.poster} alt="" /> : <div className="nw-movie-card__poster-fallback"><span>NW</span></div>}
          </div>

          <div className="nw-movie-hero__copy">
            <span className="nw-kicker">{anime || details?.is_anime ? 'Anime' : 'TV'}</span>
            <h1>{series.title}</h1>
            {details?.tagline && <p className="nw-movie-tagline">{details.tagline}</p>}
            <div className="nw-movie-meta-line">
              {series.year && <span>{series.year}</span>}
              {details?.number_of_seasons ? <span>{details.number_of_seasons} {details.number_of_seasons === 1 ? 'season' : 'seasons'}</span> : null}
              {details?.number_of_episodes ? <span>{details.number_of_episodes} episodes</span> : null}
              {series.rating > 0 && <span>★ {series.rating.toFixed(1)}</span>}
              {details?.genres?.slice(0, 3).map(genre => <span key={genre}>{genre}</span>)}
            </div>
            {series.overview && <p className="nw-movie-overview">{series.overview}</p>}
            {details?.cast && details.cast.length > 0 && (
              <div className="nw-movie-cast-line">
                <span>Cast</span>
                <strong>{details.cast.slice(0, 5).map(member => member.name).join(' · ')}</strong>
              </div>
            )}
          </div>
        </div>
      </div>

      <section className="nw-series-browser">
        {loading && (
          <div className="nw-stream-skeleton-list" aria-label="Loading TV details">
            {Array.from({ length: 5 }).map((_, index) => <span key={index} className="nw-stream-skeleton" />)}
          </div>
        )}

        {!loading && error && (
          <div className="nw-inline-notice is-error">
            <WarningTriangle width={19} height={19} />
            <div><strong>TV unavailable</strong><p>{error}</p></div>
            <button onClick={onRetry}><RefreshCircle width={16} height={16} /> Retry</button>
          </div>
        )}

        {!loading && !error && details && (
          <>
            <header className="nw-episode-toolbar">
              <div>
                <span className="nw-kicker">Episodes</span>
                <h2>{selectedEpisode ? `${episodeCode(selectedEpisode)} · ${selectedEpisode.name}` : 'Choose an episode'}</h2>
              </div>
              <div className="nw-episode-toolbar__controls">
                <label className="nw-season-picker">
                  <span>Season</span>
                  <select
                    value={seasonNumber ?? ''}
                    onChange={event => setSeasonNumber(Number(event.target.value))}
                    disabled={!seasons.length}
                  >
                    {seasons.map(season => (
                      <option key={season.id || season.season_number} value={season.season_number}>
                        {season.name} · {season.episode_count} ep
                      </option>
                    ))}
                  </select>
                </label>

                {usesEpisodeRanges && (
                  <>
                    <label className="nw-season-picker nw-episode-range-picker">
                      <span>Range</span>
                      <select
                        value={episodeRangeIndex}
                        onChange={event => {
                          setEpisodeRangeIndex(Number(event.target.value))
                          setEpisodeJumpInvalid(false)
                        }}
                      >
                        {episodeRanges.map(range => (
                          <option key={range.index} value={range.index}>{range.label}</option>
                        ))}
                      </select>
                    </label>

                    <form className={`nw-episode-jump ${episodeJumpInvalid ? 'is-error' : ''}`} onSubmit={jumpToEpisode}>
                      <span>Go to</span>
                      <input
                        type="number"
                        inputMode="numeric"
                        value={episodeJump}
                        onChange={event => {
                          setEpisodeJump(event.target.value)
                          if (episodeJumpInvalid) setEpisodeJumpInvalid(false)
                        }}
                        placeholder="Episode #"
                        aria-label="Go to episode number"
                        aria-invalid={episodeJumpInvalid}
                      />
                    </form>
                  </>
                )}
              </div>
            </header>

            {seasonLoading && (
              <div className="nw-episode-grid" aria-label="Loading episodes">
                {Array.from({ length: 8 }).map((_, index) => <span key={index} className="nw-episode-skeleton" />)}
              </div>
            )}

            {!seasonLoading && seasonError && (
              <div className="nw-inline-notice is-error compact">
                <WarningTriangle width={18} height={18} />
                <div><strong>Season unavailable</strong><p>{seasonError}</p></div>
              </div>
            )}

            {!seasonLoading && seasonData && (
              <div className="nw-episode-grid" ref={episodeGridRef}>
                {visibleEpisodes.map(episode => {
                  const active = selectedEpisode?.id === episode.id
                  return (
                    <button
                      type="button"
                      className={`nw-episode-card ${active ? 'is-active' : ''}`}
                      key={episode.id || `${episode.season_number}-${episode.episode_number}`}
                      data-episode-number={episode.episode_number}
                      onClick={() => selectEpisode(episode)}
                    >
                      <div className="nw-episode-card__still">
                        {episode.still ? <img src={episode.still} alt="" loading="lazy" /> : <span>{episodeCode(episode)}</span>}
                        <span className="nw-episode-card__number">{episodeCode(episode)}</span>
                      </div>
                      <div className="nw-episode-card__copy">
                        <strong>{episode.name}</strong>
                        <span>{[episode.air_date, runtimeLabel(episode.runtime)].filter(Boolean).join(' · ') || 'Episode'}</span>
                        {episode.overview && <p>{episode.overview}</p>}
                      </div>
                    </button>
                  )
                })}
              </div>
            )}
          </>
        )}
      </section>

      {selectedEpisode && (
        <section className="nw-streams-section nw-episode-streams">
          <div className="nw-streams-toolbar">
            <div>
              <span className="nw-kicker">Streams</span>
              <h2>{streamLoading ? 'Finding releases…' : `${visible.length} options`}</h2>
            </div>

            <div className="nw-filter-row" aria-label="Stream filters">
              <div className="nw-filter-pills">
                {(['all', '2160p', '1080p', '720p'] as QualityFilter[]).map(filter => (
                  <button
                    key={filter}
                    className={qualityFilter === filter ? 'is-active' : ''}
                    onClick={() => onQualityFilter(filter)}
                  >
                    {filter === 'all' ? 'All' : filter}
                  </button>
                ))}
              </div>
              <select value={sortMode} onChange={event => onSortMode(event.target.value as ResultSort)} aria-label="Sort streams">
                <option value="quality">Best quality</option>
                <option value="seeders">Most seeders</option>
                <option value="size">Smallest size</option>
              </select>
            </div>
          </div>

          {streamLoading && (
            <div className="nw-stream-skeleton-list" aria-label="Finding episode streams">
              {Array.from({ length: 6 }).map((_, index) => <span key={index} className="nw-stream-skeleton" />)}
            </div>
          )}

          {!streamLoading && streamError && (
            <div className="nw-inline-notice is-error compact">
              <WarningTriangle width={18} height={18} />
              <div><strong>Search failed</strong><p>{streamError}</p></div>
              <button onClick={retryStreams}><RefreshCircle width={16} height={16} /> Retry</button>
            </div>
          )}

          {!streamLoading && !streamError && streamData?.release_error && (
            <div className="nw-inline-notice is-error compact">
              <WarningTriangle width={18} height={18} />
              <div><strong>Release search unavailable</strong><p>{streamData.release_error.error}</p></div>
              <button onClick={retryStreams}><RefreshCircle width={16} height={16} /> Retry</button>
            </div>
          )}

          {!streamLoading && !streamError && !streamData?.release_error && visible.length === 0 && (
            <div className="nw-empty-state nw-empty-state--streams">
              <strong>{releases.length ? 'No matching streams' : 'No episode streams found'}</strong>
            </div>
          )}

          {!streamLoading && visible.length > 0 && details && (
            <div className="nw-stream-list">
              {visible.map((result, index) => {
                const source = releaseSource(result)
                const opening = Boolean(source && openingSource === source)
                return (
                  <button
                    type="button"
                    className="nw-stream-row"
                    key={`${result.info_hash || source}-${index}`}
                    onClick={() => onPlay(result, details, selectedEpisode)}
                    disabled={!source || Boolean(openingSource)}
                  >
                    <span className="nw-stream-row__play">
                      {opening ? <RefreshCircle width={19} height={19} className="nw-spin" /> : <Play width={19} height={19} />}
                    </span>
                    <span className="nw-stream-row__main">
                      <strong>{result.title}</strong>
                      <span>{[result.resolution, result.source, result.codec, result.audio, result.indexer].filter(value => value && value !== 'Unknown').join(' · ') || 'Torrent release'}</span>
                    </span>
                    <span className="nw-stream-row__stats">
                      <span><Group width={16} height={16} /> {result.seeders ?? 0}</span>
                      <span><HardDrive width={16} height={16} /> {formatBytes(result.size)}</span>
                    </span>
                  </button>
                )
              })}
            </div>
          )}

          <p className="nw-tmdb-credit">Metadata · TMDB</p>
        </section>
      )}
    </motion.section>
  )
}
