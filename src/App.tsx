import { type FormEvent, useCallback, useEffect, useRef, useState } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import {
  IconoirProvider,
  NavArrowRight,
  RefreshCircle,
  Search,
  WarningTriangle,
} from 'iconoir-react'
import { CatalogCard } from './components/CatalogCard'
import { HomeRail } from './components/HomeRail'
import { DiscoverView } from './components/DiscoverView'
import { SearchBar } from './components/SearchBar'
import { MovieDetailsView } from './components/MovieDetailsView'
import { SeriesDetailsView } from './components/SeriesDetailsView'
import { RuntimeDiagnostics } from './components/RuntimeDiagnostics'
import { SettingsView } from './components/SettingsView'
import { Sidebar } from './components/Sidebar'
import { TitleBar } from './components/TitleBar'
import { loadUiPreferences, saveUiPreferences, type NetWatchUiPreferences } from './utils/preferences'
import { BACKEND_BASE_URL } from './utils/api'
import {
  toMediaItem,
  toSeriesMediaItem,
  type CatalogKind,
  type DiscoverCategory,
  type DiscoverMedia,
  type MovieStreamOptions,
  type TmdbCatalogSummary,
  type TmdbEpisode,
  type TmdbHomePayload,
  type TmdbGenre,
  type TmdbMovieDetails,
  type TmdbMovieSummary,
  type TmdbSeriesDetails,
  type TmdbSeriesSummary,
} from './types/metadata'
import {
  type QualityFilter,
  type ResultSort,
  type NetWatchView,
  type TorrentSearchResult,
  assertReleaseReferences,
  resultSource,
} from './types/torrents'

const INITIAL_RUNTIME: NetWatchRuntimeStatus = {
  phase: 'starting',
  ready: false,
  message: 'Starting NetWatch…',
  error: null,
  services: {
    docker: 'pending',
    stack: 'pending',
    backend: 'pending',
    torrentEngine: 'pending',
    prowlarr: 'pending',
  },
}

const EMPTY_HOME: TmdbHomePayload = { movies: [], recent_movies: [], tv: [], recent_tv: [], anime: [], recent_anime: [] }

type DetailReturnView = 'home' | 'discover' | 'search'
type SearchReturnView = 'home' | 'discover'

function getErrorMessage(error: unknown) {
  if (error instanceof Error && error.message) return error.message
  return String(error || 'Unknown error')
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

async function searchCatalog(query: string): Promise<TmdbCatalogSummary[]> {
  const controller = new AbortController()
  const timer = window.setTimeout(() => controller.abort(), 20_000)
  try {
    const params = new URLSearchParams({ query })
    const response = await fetch(`${BACKEND_BASE_URL}/api/metadata/search?${params}`, {
      signal: controller.signal,
    })
    const payload = await readJsonResponse(response)
    return Array.isArray(payload?.results) ? payload.results : []
  } finally {
    window.clearTimeout(timer)
  }
}

async function fetchHomeCatalog(): Promise<TmdbHomePayload> {
  const controller = new AbortController()
  const timer = window.setTimeout(() => controller.abort(), 20_000)
  try {
    const response = await fetch(`${BACKEND_BASE_URL}/api/metadata/home`, { signal: controller.signal })
    const payload = await readJsonResponse(response)
    return {
      movies: Array.isArray(payload?.movies) ? payload.movies : [],
      recent_movies: Array.isArray(payload?.recent_movies) ? payload.recent_movies : [],
      tv: Array.isArray(payload?.tv) ? payload.tv : [],
      recent_tv: Array.isArray(payload?.recent_tv) ? payload.recent_tv : [],
      anime: Array.isArray(payload?.anime) ? payload.anime : [],
      recent_anime: Array.isArray(payload?.recent_anime) ? payload.recent_anime : [],
    }
  } finally {
    window.clearTimeout(timer)
  }
}

async function fetchDiscoverGenres(media: DiscoverMedia): Promise<TmdbGenre[]> {
  const controller = new AbortController()
  const timer = window.setTimeout(() => controller.abort(), 20_000)
  try {
    const params = new URLSearchParams({ media })
    const response = await fetch(`${BACKEND_BASE_URL}/api/metadata/discover/genres?${params}`, { signal: controller.signal })
    const payload = await readJsonResponse(response)
    return Array.isArray(payload?.genres) ? payload.genres : []
  } finally {
    window.clearTimeout(timer)
  }
}

async function fetchDiscoverCatalog(
  media: DiscoverMedia,
  category: DiscoverCategory,
  genreId: number | null,
): Promise<TmdbCatalogSummary[]> {
  const controller = new AbortController()
  const timer = window.setTimeout(() => controller.abort(), 30_000)
  try {
    const params = new URLSearchParams({ media, category })
    if (genreId != null) params.set('genre', String(genreId))
    const response = await fetch(`${BACKEND_BASE_URL}/api/metadata/discover?${params}`, { signal: controller.signal })
    const payload = await readJsonResponse(response)
    return Array.isArray(payload?.results) ? payload.results : []
  } finally {
    window.clearTimeout(timer)
  }
}

async function fetchMovieStreamOptions(tmdbId: number): Promise<MovieStreamOptions> {
  const controller = new AbortController()
  const timer = window.setTimeout(() => controller.abort(), 35_000)
  try {
    const response = await fetch(
      `${BACKEND_BASE_URL}/api/metadata/movies/${encodeURIComponent(String(tmdbId))}/stream-options?min_seeders=1`,
      { signal: controller.signal },
    )
    const payload = await readJsonResponse(response) as MovieStreamOptions
    assertReleaseReferences(payload.results)
    return payload
  } finally {
    window.clearTimeout(timer)
  }
}

async function fetchSeriesDetails(tmdbId: number): Promise<TmdbSeriesDetails> {
  const controller = new AbortController()
  const timer = window.setTimeout(() => controller.abort(), 20_000)
  try {
    const response = await fetch(
      `${BACKEND_BASE_URL}/api/metadata/series/${encodeURIComponent(String(tmdbId))}`,
      { signal: controller.signal },
    )
    return await readJsonResponse(response) as TmdbSeriesDetails
  } finally {
    window.clearTimeout(timer)
  }
}

export default function App() {
  const [runtime, setRuntime] = useState<NetWatchRuntimeStatus>(INITIAL_RUNTIME)
  const [view, setView] = useState<NetWatchView>('home')
  const [query, setQuery] = useState('')
  const [items, setItems] = useState<TmdbCatalogSummary[]>([])
  const [searching, setSearching] = useState(false)
  const [searchError, setSearchError] = useState<string | null>(null)
  const [hasSearched, setHasSearched] = useState(false)
  const [recentQueries, setRecentQueries] = useState<string[]>([])

  const [searchReturnView, setSearchReturnView] = useState<SearchReturnView>('home')

  const [discoverMedia, setDiscoverMedia] = useState<DiscoverMedia>('movies')
  const [discoverCategory, setDiscoverCategory] = useState<DiscoverCategory>('popular')
  const [discoverGenre, setDiscoverGenre] = useState<number | null>(null)
  const [discoverGenres, setDiscoverGenres] = useState<TmdbGenre[]>([])
  const [discoverItems, setDiscoverItems] = useState<TmdbCatalogSummary[]>([])
  const [discoverLoading, setDiscoverLoading] = useState(false)
  const [discoverError, setDiscoverError] = useState<string | null>(null)

  const [home, setHome] = useState<TmdbHomePayload>(EMPTY_HOME)
  const [homeLoading, setHomeLoading] = useState(false)
  const [homeLoaded, setHomeLoaded] = useState(false)
  const [homeError, setHomeError] = useState<string | null>(null)

  const [selectedMovie, setSelectedMovie] = useState<TmdbMovieSummary | null>(null)
  const [movieData, setMovieData] = useState<MovieStreamOptions | null>(null)
  const [movieLoading, setMovieLoading] = useState(false)
  const [movieError, setMovieError] = useState<string | null>(null)
  const [selectedMovieCatalog, setSelectedMovieCatalog] = useState<CatalogKind>('movies')

  const [selectedSeries, setSelectedSeries] = useState<TmdbSeriesSummary | null>(null)
  const [seriesData, setSeriesData] = useState<TmdbSeriesDetails | null>(null)
  const [seriesLoading, setSeriesLoading] = useState(false)
  const [seriesError, setSeriesError] = useState<string | null>(null)
  const [selectedSeriesAnime, setSelectedSeriesAnime] = useState(false)
  const [detailReturnView, setDetailReturnView] = useState<DetailReturnView>('search')

  const [diagnosticsOpen, setDiagnosticsOpen] = useState(false)
  const [preferences, setPreferences] = useState<NetWatchUiPreferences>(() => loadUiPreferences())
  const [qualityFilter, setQualityFilter] = useState<QualityFilter>(() => loadUiPreferences().defaultQuality)
  const [sortMode, setSortMode] = useState<ResultSort>('quality')
  const [opening, setOpening] = useState<string | null>(null)
  const searchPageRef = useRef<HTMLInputElement>(null)
  const homeSearchRef = useRef<HTMLInputElement>(null)
  const discoverSearchRef = useRef<HTMLInputElement>(null)
  const detailRequestId = useRef(0)
  const discoverRequestId = useRef(0)

  useEffect(() => {
    const bridge = window.electron?.runtime
    if (!bridge) {
      setRuntime({
        ...INITIAL_RUNTIME,
        phase: 'error',
        message: 'Electron bridge unavailable',
        error: 'Launch NetWatch through Electron rather than opening the renderer directly.',
      })
      return
    }

    let mounted = true
    bridge.getStatus()
      .then(status => { if (mounted) setRuntime(status) })
      .catch(error => {
        if (mounted) {
          setRuntime({ ...INITIAL_RUNTIME, phase: 'error', message: 'Startup status unavailable', error: getErrorMessage(error) })
        }
      })

    const unsubscribe = bridge.onStatus(status => setRuntime(status))
    return () => {
      mounted = false
      unsubscribe()
    }
  }, [])

  const loadHome = useCallback(async () => {
    if (!runtime.ready || homeLoading) return
    setHomeLoading(true)
    setHomeError(null)
    try {
      setHome(await fetchHomeCatalog())
      setHomeLoaded(true)
    } catch (error) {
      setHomeError(getErrorMessage(error))
    } finally {
      setHomeLoading(false)
    }
  }, [runtime.ready, homeLoading])

  useEffect(() => {
    if (runtime.ready && view === 'home' && !homeLoaded && !homeLoading && !homeError) {
      void loadHome()
    }
  }, [runtime.ready, view, homeLoaded, homeLoading, homeError, loadHome])

  const loadDiscover = useCallback(async () => {
    if (!runtime.ready) return
    const requestId = ++discoverRequestId.current
    setDiscoverLoading(true)
    setDiscoverError(null)
    try {
      const [genres, results] = await Promise.all([
        fetchDiscoverGenres(discoverMedia),
        fetchDiscoverCatalog(discoverMedia, discoverCategory, discoverGenre),
      ])
      if (requestId !== discoverRequestId.current) return
      setDiscoverGenres(genres)
      setDiscoverItems(results)
    } catch (error) {
      if (requestId !== discoverRequestId.current) return
      setDiscoverItems([])
      setDiscoverError(getErrorMessage(error))
    } finally {
      if (requestId === discoverRequestId.current) setDiscoverLoading(false)
    }
  }, [runtime.ready, discoverMedia, discoverCategory, discoverGenre])

  useEffect(() => {
    if (!runtime.ready || view !== 'discover') return
    void loadDiscover()
    return () => { ++discoverRequestId.current }
  }, [runtime.ready, view, loadDiscover])

  useEffect(() => {
    if (runtime.ready && view === 'search') searchPageRef.current?.focus()
  }, [runtime.ready, view])

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && diagnosticsOpen) {
        event.preventDefault()
        setDiagnosticsOpen(false)
        return
      }
      if (event.key === 'Escape' && (view === 'movie' || view === 'series')) {
        event.preventDefault()
        setView(detailReturnView)
        return
      }
      if (event.key === 'Escape' && view === 'search') {
        event.preventDefault()
        setView(searchReturnView)
        return
      }
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault()
        const origin: SearchReturnView = view === 'discover'
          ? 'discover'
          : view === 'home'
            ? 'home'
            : (view === 'movie' || view === 'series') && detailReturnView !== 'search'
              ? detailReturnView
              : searchReturnView
        setSearchReturnView(origin)
        setView('search')
        window.setTimeout(() => searchPageRef.current?.focus(), 0)
      }
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [diagnosticsOpen, detailReturnView, searchReturnView, view])

  useEffect(() => {
    const handleMouseBack = (event: MouseEvent) => {
      if (event.button !== 3) return

      if (diagnosticsOpen) {
        event.preventDefault()
        setDiagnosticsOpen(false)
        return
      }

      if (view === 'movie' || view === 'series') {
        event.preventDefault()
        setView(detailReturnView)
        return
      }

      if (view === 'search') {
        event.preventDefault()
        setView(searchReturnView)
      }
    }

    window.addEventListener('mouseup', handleMouseBack)
    return () => window.removeEventListener('mouseup', handleMouseBack)
  }, [diagnosticsOpen, detailReturnView, searchReturnView, view])

  const clearDetails = () => {
    ++detailRequestId.current
    setSelectedMovie(null)
    setMovieData(null)
    setMovieError(null)
    setSelectedSeries(null)
    setSeriesData(null)
    setSeriesError(null)
    setOpening(null)
  }

  const runSearch = async (event?: FormEvent, directQuery?: string) => {
    event?.preventDefault()
    const normalized = (directQuery ?? query).trim()
    if (!normalized || searching || !runtime.ready) return

    const origin: SearchReturnView = view === 'discover' ? 'discover' : view === 'home' ? 'home' : searchReturnView
    setSearchReturnView(origin)
    setQuery(normalized)
    setView('search')
    setSearching(true)
    setSearchError(null)
    setHasSearched(true)
    clearDetails()

    try {
      const next = await searchCatalog(normalized)
      setItems(next)
      setRecentQueries(current => [normalized, ...current.filter(item => item.toLowerCase() !== normalized.toLowerCase())].slice(0, 5))
    } catch (error) {
      setItems([])
      setSearchError(getErrorMessage(error))
    } finally {
      setSearching(false)
    }
  }

  const catalogForItem = (item: TmdbCatalogSummary): CatalogKind => {
    if (item.is_anime) return 'anime'
    return item.type === 'movie' ? 'movies' : 'series'
  }

  const loadMovie = async (movie: TmdbMovieSummary, sourceCatalog: CatalogKind, returnView: DetailReturnView) => {
    const requestId = ++detailRequestId.current
    setDetailReturnView(returnView)
    setSelectedMovie(movie)
    setSelectedMovieCatalog(sourceCatalog)
    setSelectedSeries(null)
    setSeriesData(null)
    setView('movie')
    setMovieLoading(true)
    setMovieError(null)
    setMovieData(null)
    setOpening(null)

    try {
      const next = await fetchMovieStreamOptions(movie.id)
      if (requestId !== detailRequestId.current) return
      setMovieData(next)
    } catch (error) {
      if (requestId !== detailRequestId.current) return
      setMovieError(getErrorMessage(error))
    } finally {
      if (requestId === detailRequestId.current) setMovieLoading(false)
    }
  }

  const loadSeries = async (series: TmdbSeriesSummary, sourceCatalog: CatalogKind, returnView: DetailReturnView) => {
    const requestId = ++detailRequestId.current
    setDetailReturnView(returnView)
    setSelectedSeries(series)
    setSelectedSeriesAnime(sourceCatalog === 'anime' || Boolean(series.is_anime))
    setSelectedMovie(null)
    setMovieData(null)
    setView('series')
    setSeriesLoading(true)
    setSeriesError(null)
    setSeriesData(null)
    setOpening(null)

    try {
      const next = await fetchSeriesDetails(series.id)
      if (requestId !== detailRequestId.current) return
      setSeriesData(next)
    } catch (error) {
      if (requestId !== detailRequestId.current) return
      setSeriesError(getErrorMessage(error))
    } finally {
      if (requestId === detailRequestId.current) setSeriesLoading(false)
    }
  }

  const loadCatalogItem = (item: TmdbCatalogSummary, returnView: DetailReturnView) => {
    const sourceCatalog = catalogForItem(item)
    if (item.type === 'movie') return void loadMovie(item as TmdbMovieSummary, sourceCatalog, returnView)
    return void loadSeries(item as TmdbSeriesSummary, sourceCatalog, returnView)
  }

  const retryMovie = () => {
    if (selectedMovie) void loadMovie(selectedMovie, selectedMovieCatalog, detailReturnView)
  }

  const retrySeries = () => {
    if (selectedSeries) void loadSeries(selectedSeries, selectedSeriesAnime ? 'anime' : 'series', detailReturnView)
  }

  const playMovieResult = async (result: TorrentSearchResult, movie: TmdbMovieDetails) => {
    const source = resultSource(result)
    if (!source || opening) return

    if (!window.electron?.player?.openTorrent) {
      setMovieError('Native player bridge unavailable. Launch NetWatch through Electron.')
      return
    }

    setOpening(source)
    setMovieError(null)

    try {
      await window.electron.player.openTorrent({
        releaseRef: source,
        title: movie.title,
        mediaName: movie.title,
        expectedHash: result.info_hash || null,
        mediaItem: toMediaItem(movie),
      })
    } catch (error) {
      setMovieError(getErrorMessage(error))
    } finally {
      setOpening(null)
    }
  }

  const playEpisodeResult = async (
    result: TorrentSearchResult,
    series: TmdbSeriesDetails,
    episode: TmdbEpisode,
  ) => {
    const source = resultSource(result)
    if (!source || opening) return

    if (!window.electron?.player?.openTorrent) {
      setSeriesError('Native player bridge unavailable. Launch NetWatch through Electron.')
      return
    }

    const code = `S${String(episode.season_number).padStart(2, '0')}E${String(episode.episode_number).padStart(2, '0')}`
    const playerTitle = `${series.title} · ${code}${episode.name ? ` · ${episode.name}` : ''}`

    setOpening(source)
    setSeriesError(null)
    try {
      await window.electron.player.openTorrent({
        releaseRef: source,
        title: playerTitle,
        mediaName: `${series.title} ${code}`,
        expectedHash: result.info_hash || null,
        mediaItem: toSeriesMediaItem(series, episode),
      })
    } catch (error) {
      setSeriesError(getErrorMessage(error))
    } finally {
      setOpening(null)
    }
  }

  const retryStartup = async () => {
    if (!window.electron?.runtime) return
    setRuntime({ ...INITIAL_RUNTIME, message: 'Retrying startup…' })
    try {
      setRuntime(await window.electron.runtime.retry())
    } catch (error) {
      setRuntime({ ...INITIAL_RUNTIME, phase: 'error', message: 'Retry failed', error: getErrorMessage(error) })
    }
  }

  const navigate = (next: NetWatchView) => {
    clearDetails()
    setView(next)
    setDiagnosticsOpen(false)
  }

  const updatePreferences = (next: NetWatchUiPreferences) => {
    setPreferences(next)
    saveUiPreferences(next)
    setQualityFilter(next.defaultQuality)
  }

  const sidebarView: NetWatchView = view === 'search'
    ? searchReturnView
    : (view === 'movie' || view === 'series')
      ? (detailReturnView === 'search' ? searchReturnView : detailReturnView)
      : view

  return (
    <IconoirProvider iconProps={{ strokeWidth: 1.65 }}>
      <div className="nw-shell">
        <TitleBar />

        <div className="nw-workspace">
          <Sidebar view={sidebarView} runtime={runtime} onNavigate={navigate} onRuntimeClick={() => setDiagnosticsOpen(true)} />

          <main className={`nw-content ${diagnosticsOpen ? 'has-drawer' : ''}`}>
            {view === 'home' ? (
              <motion.section
                className="nw-view nw-home-view"
                key="home"
                initial={{ opacity: 0, y: 4 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ duration: 0.16 }}
              >
                <header className="nw-catalog-topbar nw-home-topbar">
                  <SearchBar
                    query={query}
                    runtimeReady={runtime.ready}
                    searching={searching}
                    inputRef={homeSearchRef}
                    onQueryChange={setQuery}
                    onSubmit={runSearch}
                  />
                </header>

                {runtime.phase === 'error' && (
                  <div className="nw-inline-notice is-error nw-home-notice">
                    <WarningTriangle width={19} height={19} />
                    <div>
                      <strong>Startup failed</strong>
                      <p>{runtime.error || 'Services unavailable.'}</p>
                    </div>
                    <button onClick={() => void retryStartup()}>
                      <RefreshCircle width={16} height={16} /> Retry
                    </button>
                  </div>
                )}

                {homeError && runtime.ready && (
                  <div className="nw-inline-notice is-error nw-home-notice compact">
                    <WarningTriangle width={18} height={18} />
                    <div><strong>Catalog unavailable</strong><p>{homeError}</p></div>
                    <button onClick={() => void loadHome()}><RefreshCircle width={16} height={16} /> Retry</button>
                  </div>
                )}

                <div className="nw-home-feed">
                  <HomeRail
                    title="Trending Movies"
                    items={home.movies}
                    loading={homeLoading && !homeLoaded}
                    onSelect={item => loadCatalogItem(item, 'home')}
                  />
                  <HomeRail
                    title="Recent Movies"
                    items={home.recent_movies}
                    loading={homeLoading && !homeLoaded}
                    onSelect={item => loadCatalogItem(item, 'home')}
                  />
                  <HomeRail
                    title="Trending TV"
                    items={home.tv}
                    loading={homeLoading && !homeLoaded}
                    onSelect={item => loadCatalogItem(item, 'home')}
                  />
                  <HomeRail
                    title="Recent TV"
                    items={home.recent_tv}
                    loading={homeLoading && !homeLoaded}
                    onSelect={item => loadCatalogItem(item, 'home')}
                  />
                  <HomeRail
                    title="Trending Anime"
                    items={home.anime}
                    loading={homeLoading && !homeLoaded}
                    onSelect={item => loadCatalogItem(item, 'home')}
                  />
                  <HomeRail
                    title="Recent Anime"
                    items={home.recent_anime}
                    loading={homeLoading && !homeLoaded}
                    onSelect={item => loadCatalogItem(item, 'home')}
                  />
                  <p className="nw-tmdb-credit nw-home-credit">Metadata · TMDB</p>
                </div>
              </motion.section>
            ) : view === 'discover' ? (
              <DiscoverView
                query={query}
                runtimeReady={runtime.ready}
                searching={searching}
                searchInputRef={discoverSearchRef}
                onQueryChange={setQuery}
                onSearch={runSearch}
                media={discoverMedia}
                category={discoverCategory}
                genreId={discoverGenre}
                genres={discoverGenres}
                items={discoverItems}
                loading={discoverLoading}
                error={discoverError}
                onMediaChange={value => {
                  setDiscoverMedia(value)
                  setDiscoverGenre(null)
                }}
                onCategoryChange={setDiscoverCategory}
                onGenreChange={setDiscoverGenre}
                onRetry={() => void loadDiscover()}
                onSelect={item => loadCatalogItem(item, 'discover')}
              />
            ) : view === 'settings' ? (
              <SettingsView
                preferences={preferences}
                onChange={updatePreferences}
                onOpenDiagnostics={() => setDiagnosticsOpen(true)}
              />
            ) : view === 'movie' && selectedMovie ? (
              <MovieDetailsView
                seedMovie={selectedMovie}
                data={movieData}
                loading={movieLoading}
                error={movieError}
                openingSource={opening}
                qualityFilter={qualityFilter}
                sortMode={sortMode}
                catalogLabel={selectedMovieCatalog === 'anime' ? 'Anime' : 'Movie'}
                onQualityFilter={setQualityFilter}
                onSortMode={setSortMode}
                onBack={() => setView(detailReturnView)}
                onRetry={retryMovie}
                onPlay={(result, movie) => void playMovieResult(result, movie)}
              />
            ) : view === 'series' && selectedSeries ? (
              <SeriesDetailsView
                seedSeries={selectedSeries}
                details={seriesData}
                loading={seriesLoading}
                error={seriesError}
                openingSource={opening}
                qualityFilter={qualityFilter}
                sortMode={sortMode}
                anime={selectedSeriesAnime}
                onQualityFilter={setQualityFilter}
                onSortMode={setSortMode}
                onBack={() => setView(detailReturnView)}
                onRetry={retrySeries}
                onPlay={(result, series, episode) => void playEpisodeResult(result, series, episode)}
              />
            ) : (
              <motion.section
                className="nw-view nw-search-view"
                key="search"
                initial={{ opacity: 0, y: 4 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ duration: 0.16 }}
              >
                <header className="nw-search-header nw-search-header--simple">
                  <SearchBar
                    query={query}
                    runtimeReady={runtime.ready}
                    searching={searching}
                    inputRef={searchPageRef}
                    onQueryChange={setQuery}
                    onSubmit={runSearch}
                  />
                </header>

                {runtime.phase === 'error' && (
                  <div className="nw-inline-notice is-error">
                    <WarningTriangle width={19} height={19} />
                    <div><strong>Search unavailable</strong><p>{runtime.error || runtime.message}</p></div>
                    <button onClick={() => void retryStartup()}><RefreshCircle width={16} height={16} /> Retry</button>
                  </div>
                )}

                {searchError && (
                  <div className="nw-inline-notice is-error compact">
                    <WarningTriangle width={18} height={18} />
                    <div><strong>Search failed</strong><p>{searchError}</p></div>
                  </div>
                )}

                {!hasSearched && recentQueries.length > 0 && (
                  <section className="nw-search-recent" aria-label="Recent searches">
                    <span className="nw-settings-label">Recent</span>
                    <div className="nw-query-chips">
                      {recentQueries.map(item => (
                        <button key={item} onClick={() => void runSearch(undefined, item)}>
                          <span>{item}</span>
                          <NavArrowRight width={14} height={14} />
                        </button>
                      ))}
                    </div>
                  </section>
                )}

                <section className="nw-results-section">
                  {hasSearched && (
                    <div className="nw-results-toolbar">
                      <h2>{searching ? 'Searching' : `${items.length} results`}</h2>
                    </div>
                  )}

                  {hasSearched && searching && (
                    <div className="nw-movie-skeleton-grid" aria-label="Searching titles">
                      {Array.from({ length: 10 }).map((_, index) => <span key={index} className="nw-movie-skeleton" />)}
                    </div>
                  )}

                  {hasSearched && !searching && items.length === 0 && !searchError && (
                    <div className="nw-empty-state">
                      <div className="nw-empty-state__icon"><Search width={28} height={28} /></div>
                      <strong>No results</strong>
                    </div>
                  )}

                  {!searching && items.length > 0 && (
                    <div className="nw-movie-grid">
                      {items.map(item => (
                        <CatalogCard
                          key={`${item.type}-${item.id}`}
                          item={item}
                          onSelect={() => loadCatalogItem(item, 'search')}
                        />
                      ))}
                    </div>
                  )}

                  {hasSearched && <p className="nw-tmdb-credit nw-tmdb-credit--search">Metadata · TMDB</p>}
                </section>
              </motion.section>
            )}

            <AnimatePresence>
              {diagnosticsOpen && (
                <RuntimeDiagnostics
                  runtime={runtime}
                  onClose={() => setDiagnosticsOpen(false)}
                  onRetry={() => void retryStartup()}
                />
              )}
            </AnimatePresence>
          </main>
        </div>
      </div>
    </IconoirProvider>
  )
}
