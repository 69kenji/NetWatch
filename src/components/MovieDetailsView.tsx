import { motion } from 'framer-motion'
import {
  Group,
  HardDrive,
  NavArrowLeft,
  Play,
  RefreshCircle,
  WarningTriangle,
} from 'iconoir-react'
import type { MovieStreamOptions, TmdbMovieDetails, TmdbMovieSummary } from '../types/metadata'
import { formatBytes, sortResults, type QualityFilter, type ResultSort, type TorrentSearchResult } from '../types/torrents'

interface MovieDetailsViewProps {
  seedMovie: TmdbMovieSummary
  data: MovieStreamOptions | null
  loading: boolean
  error: string | null
  openingSource: string | null
  qualityFilter: QualityFilter
  sortMode: ResultSort
  onQualityFilter: (value: QualityFilter) => void
  onSortMode: (value: ResultSort) => void
  onBack: () => void
  onRetry: () => void
  onPlay: (result: TorrentSearchResult, movie: TmdbMovieDetails) => void
  catalogLabel?: string
}

function runtimeLabel(minutes?: number | null) {
  if (!minutes || minutes <= 0) return null
  const hours = Math.floor(minutes / 60)
  const rest = minutes % 60
  return hours ? `${hours}h ${rest}m` : `${rest}m`
}

function releaseSource(result: TorrentSearchResult) {
  return result.source_url || result.magnet || ''
}

export function MovieDetailsView({
  seedMovie,
  data,
  loading,
  error,
  openingSource,
  qualityFilter,
  sortMode,
  onQualityFilter,
  onSortMode,
  onBack,
  onRetry,
  onPlay,
  catalogLabel = 'Movie',
}: MovieDetailsViewProps) {
  const movie = data?.movie || seedMovie
  const details = data?.movie || ({ ...seedMovie, genres: [], cast: [] } as TmdbMovieDetails)
  const releases = data?.results || []
  const filtered = qualityFilter === 'all'
    ? releases
    : releases.filter(result => result.resolution?.toLowerCase() === qualityFilter.toLowerCase())
  const visible = sortResults(filtered, sortMode)

  return (
    <motion.section
      className="nw-view nw-movie-view"
      key={`movie-${movie.id}`}
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      transition={{ duration: 0.2 }}
    >
      <div className="nw-movie-hero">
        <div className="nw-movie-hero__backdrop" aria-hidden="true">
          {movie.backdrop ? <img src={movie.backdrop} alt="" draggable={false} /> : null}
        </div>
        <div className="nw-movie-hero__veil" aria-hidden="true" />

        <button className="nw-movie-back" onClick={onBack} aria-label="Back to movie results">
          <NavArrowLeft width={20} height={20} />
          <span>Back</span>
        </button>

        <div className="nw-movie-hero__content">
          <div className="nw-movie-hero__poster">
            {movie.poster ? <img src={movie.poster} alt="" /> : <div className="nw-movie-card__poster-fallback"><span>NW</span></div>}
          </div>

          <div className="nw-movie-hero__copy">
            <span className="nw-kicker">{catalogLabel}</span>
            <h1>{movie.title}</h1>
            {details.tagline && <p className="nw-movie-tagline">{details.tagline}</p>}
            <div className="nw-movie-meta-line">
              {movie.year && <span>{movie.year}</span>}
              {details.runtime ? <span>{runtimeLabel(details.runtime)}</span> : null}
              {movie.rating > 0 && <span>★ {movie.rating.toFixed(1)}</span>}
              {details.genres?.slice(0, 3).map(genre => <span key={genre}>{genre}</span>)}
            </div>
            {movie.overview && <p className="nw-movie-overview">{movie.overview}</p>}

            {details.cast && details.cast.length > 0 && (
              <div className="nw-movie-cast-line">
                <span>Cast</span>
                <strong>{details.cast.slice(0, 5).map(member => member.name).join(' · ')}</strong>
              </div>
            )}
          </div>
        </div>
      </div>

      <section className="nw-streams-section">
        <div className="nw-streams-toolbar">
          <div>
            <span className="nw-kicker">Streams</span>
            <h2>{loading ? 'Finding releases…' : `${visible.length} options`}</h2>
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

        {loading && (
          <div className="nw-stream-skeleton-list" aria-label="Finding streams">
            {Array.from({ length: 6 }).map((_, index) => <span key={index} className="nw-stream-skeleton" />)}
          </div>
        )}

        {!loading && error && (
          <div className="nw-inline-notice is-error">
            <WarningTriangle width={19} height={19} />
            <div><strong>Movie unavailable</strong><p>{error}</p></div>
            <button onClick={onRetry}><RefreshCircle width={16} height={16} /> Retry</button>
          </div>
        )}

        {!loading && !error && data?.release_error && (
          <div className="nw-inline-notice is-error compact">
            <WarningTriangle width={18} height={18} />
            <div>
              <strong>Release search unavailable</strong>
              <p>{data.release_error.error || 'Search did not respond.'}</p>
            </div>
            <button onClick={onRetry}><RefreshCircle width={16} height={16} /> Retry</button>
          </div>
        )}

        {!loading && !error && !data?.release_error && visible.length === 0 && (
          <div className="nw-empty-state nw-empty-state--streams">
            <strong>{releases.length ? 'No matching streams' : 'No streams found'}</strong>
          </div>
        )}

        {!loading && visible.length > 0 && (
          <div className="nw-stream-list">
            {visible.map((result, index) => {
              const source = releaseSource(result)
              const opening = Boolean(source && openingSource === source)
              return (
                <button
                  type="button"
                  className="nw-stream-row"
                  key={`${result.info_hash || source}-${index}`}
                  onClick={() => onPlay(result, details)}
                  disabled={!source || Boolean(openingSource)}
                >
                  <span className="nw-stream-row__play">
                    {opening ? <RefreshCircle width={19} height={19} className="nw-spin" /> : <Play width={19} height={19} />}
                  </span>
                  <span className="nw-stream-row__main">
                    <strong>{result.title}</strong>
                    <span>
                      {[result.resolution, result.source, result.codec, result.audio, result.indexer]
                        .filter(value => value && value !== 'Unknown')
                        .join(' · ') || 'Torrent release'}
                    </span>
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
    </motion.section>
  )
}
