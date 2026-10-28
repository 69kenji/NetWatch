import { type FormEvent, useCallback, useEffect, useRef, useState } from 'react'
import { motion, AnimatePresence, MotionConfig } from 'framer-motion'
import {
  IconoirProvider,
  RefreshCircle,
  Search,
  WarningTriangle,
  Xmark,
} from 'iconoir-react'
import { CatalogCard } from './components/CatalogCard'
import { HomeRail } from './components/HomeRail'
import { CollectionsView } from './components/CollectionsView'
import { CardActionsProvider } from './components/CardActions'
import { KeepWatchingRail, type HydratedKeepWatchingItem } from './components/KeepWatchingRail'
import { DiscoverView } from './components/DiscoverView'
import { SearchBar } from './components/SearchBar'
import { MovieDetailsView } from './components/MovieDetailsView'
import { SeriesDetailsView } from './components/SeriesDetailsView'
import { RuntimeDiagnostics } from './components/RuntimeDiagnostics'
import { SettingsView } from './components/SettingsView'
import { ProfilePage } from './components/ProfilePage'
import { HistoryView } from './components/HistoryView'
import { QueueView, type PlaybackQueueItem } from './components/QueueView'
import { Sidebar } from './components/Sidebar'
import { LibraryView } from './components/LibraryView'
import { TitleBar } from './components/TitleBar'
import { loadUiPreferences, saveUiPreferences, type HomeRailKey, type NetWatchUiPreferences } from './utils/preferences'
import { BACKEND_BASE_URL } from './utils/api'
import { localCatalog, useLocalCatalog } from './store/localCatalog'
import { normalizeSearchQuery } from './utils/localCatalog'
import { profileStorage } from './utils/profileStorage'
import { useDirectionalNavigation } from './hooks/useDirectionalNavigation'
import { PLAYBACK_DEFAULTS, normalizePlaybackPreferences } from '../shared/playback-preferences.mjs'
import {
  toMediaItem,
  toSeriesMediaItem,
  type CatalogKind,
  type DiscoverCategory,
  type DiscoverMedia,
  type MovieStreamOptions,
  type EpisodeStreamOptions,
  type TmdbCatalogSummary,
  type TmdbEpisode,
  type TmdbHomePayload,
  type TmdbGenre,
  type TmdbMovieDetails,
  type TmdbMovieSummary,
  type TmdbSeriesDetails,
  type TmdbSeriesSummary,
  type TmdbSeasonDetails,
} from './types/metadata'
import {
  type QualityFilter,
  type ResultSort,
  type NetWatchView,
  type TorrentSearchResult,
  assertReleaseReferences,
  resultSource,
  selectAutomaticResult,
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

type DetailReturnView = 'home' | 'discover' | 'search' | 'collections' | 'library' | 'history' | 'queue' | 'profile'
type SearchReturnView = 'home' | 'discover' | 'settings' | 'history' | 'queue' | 'profile'
type SimpleNavigationView = 'home' | 'discover' | 'settings' | 'library' | 'collections' | 'history' | 'queue' | 'profile'
type NavigationEntry =
  | { view: SimpleNavigationView }
  | { view: 'search'; returnView: SearchReturnView }
  | {
      view: 'movie'
      seed: TmdbMovieSummary
      catalog: CatalogKind
      data: MovieStreamOptions | null
      error: string | null
      returnView: DetailReturnView
    }
  | {
      view: 'series'
      seed: TmdbSeriesSummary
      data: TmdbSeriesDetails | null
      error: string | null
      anime: boolean
      returnView: DetailReturnView
    }

const NAVIGATION_HISTORY_LIMIT = 50

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
  personId: number | null = null,
): Promise<TmdbCatalogSummary[]> {
  const controller = new AbortController()
  const timer = window.setTimeout(() => controller.abort(), 30_000)
  try {
    const params = new URLSearchParams({ media, category })
    if (genreId != null) params.set('genre', String(genreId))
    if (personId != null) params.set('person', String(personId))
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

async function fetchMovieDetails(tmdbId: number): Promise<TmdbMovieDetails> {
  const controller = new AbortController()
  const timer = window.setTimeout(() => controller.abort(), 20_000)
  try {
    const response = await fetch(`${BACKEND_BASE_URL}/api/metadata/movies/${encodeURIComponent(String(tmdbId))}`, { signal: controller.signal })
    return await readJsonResponse(response) as TmdbMovieDetails
  } finally {
    window.clearTimeout(timer)
  }
}

async function fetchSeriesSeason(tmdbId: number, season: number): Promise<TmdbSeasonDetails> {
  const controller = new AbortController()
  const timer = window.setTimeout(() => controller.abort(), 20_000)
  try {
    const response = await fetch(`${BACKEND_BASE_URL}/api/metadata/series/${encodeURIComponent(String(tmdbId))}/seasons/${season}`, { signal: controller.signal })
    return await readJsonResponse(response) as TmdbSeasonDetails
  } finally {
    window.clearTimeout(timer)
  }
}

async function fetchEpisodeStreamOptions(
  tmdbId: number,
  season: number,
  episode: number,
  anime: boolean,
): Promise<EpisodeStreamOptions> {
  const params = new URLSearchParams({ min_seeders: '1', anime: anime ? 'true' : 'false' })
  const controller = new AbortController()
  const timer = window.setTimeout(() => controller.abort(), 35_000)
  try {
    const response = await fetch(
      `${BACKEND_BASE_URL}/api/metadata/series/${encodeURIComponent(String(tmdbId))}/episodes/${season}/${episode}/stream-options?${params}`,
      { signal: controller.signal },
    )
    const payload = await readJsonResponse(response) as EpisodeStreamOptions
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
  const localData = useLocalCatalog()
  const [runtime, setRuntime] = useState<NetWatchRuntimeStatus>(INITIAL_RUNTIME)
  const [view, setView] = useState<NetWatchView>('home')
  const [query, setQuery] = useState('')
  const [items, setItems] = useState<TmdbCatalogSummary[]>([])
  const [searching, setSearching] = useState(false)
  const [searchError, setSearchError] = useState<string | null>(null)
  const [hasSearched, setHasSearched] = useState(false)

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
  const [keepWatchingItems, setKeepWatchingItems] = useState<HydratedKeepWatchingItem[]>([])
  const [keepWatchingOpening, setKeepWatchingOpening] = useState<string | null>(null)
  const [keepWatchingError, setKeepWatchingError] = useState<string | null>(null)
  const [quickPlayError, setQuickPlayError] = useState<string | null>(null)
  const [profileHistory, setProfileHistory] = useState<NetWatchViewingHistoryEntry[]>([])
  const [recommendations, setRecommendations] = useState<TmdbCatalogSummary[]>([])
  const [recommendationTitle, setRecommendationTitle] = useState('Recommended for you')
  const recommendationRefresh = useRef('')

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
  const [playbackQueue, setPlaybackQueue] = useState<PlaybackQueueItem[]>([])
  const [collectionSelection, setCollectionSelection] = useState('my-list')
  const searchPageRef = useRef<HTMLInputElement>(null)
  const homeSearchRef = useRef<HTMLInputElement>(null)
  const discoverSearchRef = useRef<HTMLInputElement>(null)
  const detailRequestId = useRef(0)
  const discoverRequestId = useRef(0)
  const keepWatchingRequestId = useRef(0)
  const keepWatchingMetadata = useRef(new Map<string, TmdbCatalogSummary>())
  const [watchRecords, setWatchRecords] = useState<NetWatchKeepWatchingItem[]>([])
  const [episodeProgress, setEpisodeProgress] = useState<NetWatchKeepWatchingItem[]>([])
  const quickPlayRequest = useRef(0)
  const quickPlayBusy = useRef(false)
  useEffect(() => () => { ++quickPlayRequest.current; quickPlayBusy.current = false }, [])
  const cancelQuickPlay = () => {
    ++quickPlayRequest.current
    quickPlayBusy.current = false
    setKeepWatchingOpening(null)
    setQuickPlayError(null)
  }
  const navigationBack = useRef<NavigationEntry[]>([])
  const navigationForward = useRef<NavigationEntry[]>([])

  useEffect(() => {
    let active = true
    const api = window.electron?.history
    if (!api) return
    const apply = (state: NetWatchViewingHistoryState) => { if (active) setProfileHistory(state.entries) }
    const unsubscribe = api.onChanged(apply)
    void api.getState().then(apply).catch(() => {})
    return () => { active = false; unsubscribe() }
  }, [])

  useEffect(() => {
    if (!runtime.ready || !profileHistory.length) { setRecommendations([]); return }
    let active = true
    const watchedIds = new Set(profileHistory.map(entry => entry.catalogId))
    const favorite = [...profileHistory].sort((a, b) => b.watchedSeconds - a.watchedSeconds)[0]
    const genreSeconds = new Map<string, number>()
    for (const entry of profileHistory) for (const genre of entry.genres) genreSeconds.set(genre, (genreSeconds.get(genre) || 0) + entry.watchedSeconds)
    const genre = [...genreSeconds.entries()].sort((a, b) => b[1] - a[1])[0]?.[0]
    const media: DiscoverMedia = favorite?.isAnime ? 'anime' : favorite?.type === 'movie' ? 'movies' : 'tv'
    const refreshKey = `${media}:${genre || ''}:${[...watchedIds].sort().join(',')}:${localData.titles.map(item => `${item.type}:${item.id}`).sort().join(',')}:${localData.collections.watched.slice().sort().join(',')}`
    if (recommendationRefresh.current === refreshKey) return
    recommendationRefresh.current = refreshKey
    void (async () => {
      try {
        const genres = await fetchDiscoverGenres(media)
        const genreId = genre ? genres.find(item => item.name.toLocaleLowerCase() === genre.toLocaleLowerCase())?.id ?? null : null
        const details = favorite?.type === 'movie'
          ? await fetchMovieDetails(Number(favorite.catalogId.split(':')[1]))
          : await fetchSeriesDetails(Number(favorite.catalogId.split(':')[1]))
        const person = details.people?.[0]
        const [discovered, byPerson] = await Promise.all([
          fetchDiscoverCatalog(media, 'popular', genreId),
          person ? fetchDiscoverCatalog(media, 'popular', null, person.id) : Promise.resolve([]),
        ])
        const saved = localData.titles.filter(item => !localData.collections.watched.includes(`${item.type}-${item.id}`)).map(item => ({ ...item, overview: '', rating: 0 }))
        const unique = new Map<string, TmdbCatalogSummary>()
        for (const item of [...saved, ...byPerson, ...discovered]) if (!watchedIds.has(`${item.type}:${item.id}`)) unique.set(`${item.type}:${item.id}`, item)
        if (active) {
          setRecommendations([...unique.values()].slice(0, 20))
          setRecommendationTitle(person ? `More with ${person.name}` : genre ? `Because you watch ${genre.toLocaleLowerCase()}` : favorite?.isAnime ? 'Because you watch anime' : 'From your saved titles')
        }
      } catch { if (active) setRecommendations([]) }
    })()
    return () => { active = false }
  }, [runtime.ready, profileHistory, localData.titles, localData.collections.watched])

  useEffect(() => {
    const completed = new Map<string, NetWatchViewingHistoryEntry>()
    for (const entry of profileHistory.filter(item => item.type === 'movie' && item.completed)) completed.set(entry.catalogId, entry)
    const series = new Map<string, { entry: NetWatchViewingHistoryEntry; episodes: Set<string>; total: number }>()
    for (const entry of profileHistory.filter(item => item.type === 'tv')) {
      const current = series.get(entry.catalogId) || { entry, episodes: new Set<string>(), total: 0 }
      if (entry.completed) current.episodes.add(`${entry.season}:${entry.episode}`)
      current.total = Math.max(current.total, Number(entry.totalEpisodes || 0)); series.set(entry.catalogId, current)
    }
    for (const [id, value] of series) if (value.total > 0 && value.episodes.size >= value.total) completed.set(id, value.entry)
    for (const [catalogId, entry] of completed) {
      const key = catalogId.replace(':', '-')
      if (!localData.collections.watched.includes(key)) localCatalog.setWatched({
        id: Number(catalogId.split(':')[1]), type: entry.type, title: entry.title, year: entry.year,
        poster: entry.poster, backdrop: entry.backdrop, is_anime: entry.isAnime,
      }, true)
    }
  }, [profileHistory, localData.collections.watched])

  useEffect(() => {
    if (!runtime.ready || !preferences.trackedSeriesNotifications) return
    const tracked = [...new Map(profileHistory.filter(entry => entry.type === 'tv').map(entry => [entry.catalogId, entry])).values()].slice(0, 20)
    if (!tracked.length) return
    let active = true
    void (async () => {
      let checkedAt = 0, previous: Record<string, number> = {}
      try {
        const saved = JSON.parse(profileStorage.getItem('netwatch-tracked-series-v1') || '{}')
        checkedAt = Number(saved?.checkedAt || 0)
        previous = saved?.counts && typeof saved.counts === 'object' ? saved.counts : saved
      } catch {}
      if (Date.now() - checkedAt < 6 * 60 * 60 * 1000) return
      const next: Record<string, number> = {}, updated: string[] = []
      for (const entry of tracked) {
        if (!active) return
        try {
          const details = await fetchSeriesDetails(Number(entry.catalogId.split(':')[1]))
          const total = Math.max(0, Number(details.number_of_episodes || 0))
          next[entry.catalogId] = total
          if (Number(previous[entry.catalogId] || 0) > 0 && total > previous[entry.catalogId] && (!details.last_air_date || Date.parse(details.last_air_date) <= Date.now())) updated.push(details.title)
        } catch { next[entry.catalogId] = Number(previous[entry.catalogId] || 0) }
      }
      if (!active) return
      try { profileStorage.setItem('netwatch-tracked-series-v1', JSON.stringify({ checkedAt: Date.now(), counts: next })) } catch {}
      if (updated.length) await window.electron?.notifications.seriesUpdates(updated)
    })()
    return () => { active = false }
  }, [runtime.ready, preferences.trackedSeriesNotifications, profileHistory])

  const applyMainSettings = useCallback((settings: NetWatchAppSettings) => {
    setPreferences(current => {
      const next = {
        ...current,
        appearance: settings.appearance,
        ...normalizePlaybackPreferences(settings),
        defaultQuality: settings.defaultQuality,
        onClose: settings.onClose,
        startWithWindows: settings.startWithWindows,
        startMinimized: settings.startMinimized,
        updateNotifications: settings.updateNotifications,
        keepWatchingEnabled: settings.keepWatchingEnabled,
        keepWatchingLimit: settings.keepWatchingLimit,
        flareSolverrEnabled: settings.flareSolverrEnabled,
        resourceProfile: settings.resourceProfile,
        alwaysSkipIntro: settings.alwaysSkipIntro,
      }
      saveUiPreferences(next)
      return next
    })
    setQualityFilter(settings.defaultQuality)
  }, [])

  useEffect(() => {
    let active = true
    const refresh = () => {
      void window.electron?.settings.get().then(settings => {
        if (active) applyMainSettings(settings)
      }).catch(() => {})
    }
    window.addEventListener('focus', refresh)
    return () => { active = false; window.removeEventListener('focus', refresh) }
  }, [applyMainSettings])

  useEffect(() => {
    const api = window.electron?.settings
    if (!api) return
    void api.get()
      .then(applyMainSettings)
      .catch(() => {})
  }, [applyMainSettings])

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

  const hydrateKeepWatching = useCallback(async (state: NetWatchKeepWatchingState) => {
    const requestId = ++keepWatchingRequestId.current
    setWatchRecords(state.enabled ? state.items : [])
    setEpisodeProgress(state.enabled ? state.episodeProgress || [] : [])
    if (!state.enabled || !state.items.length) {
      if (!state.enabled) keepWatchingMetadata.current.clear()
      setKeepWatchingItems([])
      return
    }
    const hydrated = await Promise.all(state.items.map(async record => {
      try {
        const cached = keepWatchingMetadata.current.get(record.catalog_id)
        if (cached) return { record, item: cached } as HydratedKeepWatchingItem
        const id = Number(record.catalog_id.split(':')[1])
        const item = record.catalog_id.startsWith('movie:')
          ? await fetchMovieDetails(id)
          : await fetchSeriesDetails(id)
        keepWatchingMetadata.current.set(record.catalog_id, item)
        return { record, item } as HydratedKeepWatchingItem
      } catch {
        return null
      }
    }))
    if (requestId === keepWatchingRequestId.current) {
      setKeepWatchingItems(hydrated.filter((entry): entry is HydratedKeepWatchingItem => Boolean(entry)))
    }
  }, [])

  useEffect(() => {
    const api = window.electron?.keepWatching
    if (!api || !runtime.ready) return
    let active = true
    void api.getState().then(state => { if (active) void hydrateKeepWatching(state) }).catch(() => {})
    const off = api.onChanged(state => { if (active) void hydrateKeepWatching(state) })
    return () => {
      active = false
      ++keepWatchingRequestId.current
      off()
    }
  }, [hydrateKeepWatching, runtime.ready])

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

  const clearDetails = () => {
    ++detailRequestId.current
    setSelectedMovie(null)
    setMovieData(null)
    setMovieError(null)
    setSelectedSeries(null)
    setSeriesData(null)
    setSeriesError(null)
    setMovieLoading(false)
    setSeriesLoading(false)
    setOpening(null)
  }

  const captureNavigationEntry = (): NavigationEntry => {
    if (view === 'movie' && selectedMovie) {
      return {
        view: 'movie',
        seed: selectedMovie,
        catalog: selectedMovieCatalog,
        data: movieData,
        error: movieError,
        returnView: detailReturnView,
      }
    }
    if (view === 'series' && selectedSeries) {
      return {
        view: 'series',
        seed: selectedSeries,
        data: seriesData,
        error: seriesError,
        anime: selectedSeriesAnime,
        returnView: detailReturnView,
      }
    }
    if (view === 'movie' || view === 'series') {
      return detailReturnView === 'search'
        ? { view: 'search', returnView: searchReturnView }
        : { view: detailReturnView }
    }
    if (view === 'search') return { view: 'search', returnView: searchReturnView }
    return { view }
  }

  const navigationKey = (entry: NavigationEntry) => {
    if (entry.view === 'movie') return `movie:${entry.seed.id}`
    if (entry.view === 'series') return `series:${entry.seed.id}`
    return entry.view
  }

  const recordNavigation = (next: NavigationEntry) => {
    const current = captureNavigationEntry()
    if (navigationKey(current) === navigationKey(next)) return false
    navigationBack.current = [...navigationBack.current, current].slice(-NAVIGATION_HISTORY_LIMIT)
    navigationForward.current = []
    return true
  }

  const runSearch = async (event?: FormEvent, directQuery?: string) => {
    event?.preventDefault()
    const normalized = normalizeSearchQuery(directQuery ?? query)
    if (!normalized || searching || !runtime.ready) return
    cancelQuickPlay()
    localCatalog.recordSearch(normalized)

    const origin: SearchReturnView = view === 'discover' ? 'discover' : view === 'home' ? 'home' : view === 'profile' ? 'profile' : view === 'history' ? 'history' : view === 'queue' ? 'queue' : searchReturnView
    if (view !== 'search') recordNavigation({ view: 'search', returnView: origin })
    else navigationForward.current = []
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

  const applyNavigationEntry = (entry: NavigationEntry) => {
    cancelQuickPlay()
    setDiagnosticsOpen(false)
    if (entry.view === 'movie') {
      if (!entry.data && !entry.error) {
        void loadMovie(entry.seed, entry.catalog, entry.returnView)
        return
      }
      ++detailRequestId.current
      setDetailReturnView(entry.returnView)
      setSelectedMovie(entry.seed)
      setSelectedMovieCatalog(entry.catalog)
      setMovieData(entry.data)
      setMovieError(entry.error)
      setMovieLoading(false)
      setSelectedSeries(null)
      setSeriesData(null)
      setSeriesError(null)
      setSeriesLoading(false)
      setOpening(null)
      setView('movie')
      return
    }
    if (entry.view === 'series') {
      if (!entry.data && !entry.error) {
        void loadSeries(entry.seed, entry.anime ? 'anime' : 'series', entry.returnView)
        return
      }
      ++detailRequestId.current
      setDetailReturnView(entry.returnView)
      setSelectedSeries(entry.seed)
      setSelectedSeriesAnime(entry.anime)
      setSeriesData(entry.data)
      setSeriesError(entry.error)
      setSeriesLoading(false)
      setSelectedMovie(null)
      setMovieData(null)
      setMovieError(null)
      setMovieLoading(false)
      setOpening(null)
      setView('series')
      return
    }
    if (entry.view === 'search') setSearchReturnView(entry.returnView)
    clearDetails()
    setView(entry.view)
  }

  const loadCatalogItem = (item: TmdbCatalogSummary, returnView: DetailReturnView) => {
    const sourceCatalog = catalogForItem(item)
    const entry: NavigationEntry = item.type === 'movie'
      ? {
          view: 'movie',
          seed: item as TmdbMovieSummary,
          catalog: sourceCatalog,
          data: null,
          error: null,
          returnView,
        }
      : {
          view: 'series',
          seed: item as TmdbSeriesSummary,
          data: null,
          error: null,
          anime: sourceCatalog === 'anime' || Boolean(item.is_anime),
          returnView,
        }
    recordNavigation(entry)
    applyNavigationEntry(entry)
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
    resumePositionSeconds?: number,
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
        resumePositionSeconds,
      })
    } catch (error) {
      setSeriesError(getErrorMessage(error))
    } finally {
      setOpening(null)
    }
  }

  const playEpisodeAutomatically = async (series: TmdbSeriesDetails, episode: TmdbEpisode, resumePositionSeconds?: number, resetProgress = false) => {
    const bridge = window.electron?.player
    const progress = window.electron?.keepWatching
    if (!bridge?.openTorrent || !progress || opening) return
    setSeriesError(null)
    try {
      const data = await fetchEpisodeStreamOptions(series.id, episode.season_number, episode.episode_number, Boolean(series.is_anime))
      const selected = selectAutomaticResult(data.results, preferences.defaultQuality)
      if (!selected) throw new Error(data.release_error ? 'Release search is unavailable. Try again.' : 'No release matches your default quality.')
      const source = resultSource(selected)
      if (!source) throw new Error('The selected release is unavailable.')
      const code = `S${String(episode.season_number).padStart(2, '0')}E${String(episode.episode_number).padStart(2, '0')}`
      setOpening(source)
      await bridge.openTorrent({
        releaseRef: source,
        title: `${series.title} · ${code}${episode.name ? ` · ${episode.name}` : ''}`,
        mediaName: `${series.title} ${code}`,
        expectedHash: selected.info_hash || null,
        mediaItem: toSeriesMediaItem(series, episode),
        resumePositionSeconds,
      })
      if (resetProgress) {
        const result = await progress.removeEpisode(`tv:${series.id}`, episode.season_number, episode.episode_number)
        await hydrateKeepWatching(result.state)
      }
    } catch (error) {
      setSeriesError(getErrorMessage(error))
    } finally {
      setOpening(null)
    }
  }

  const playEpisodeFromBeginning = (series: TmdbSeriesDetails, episode: TmdbEpisode) => playEpisodeAutomatically(series, episode, undefined, true)

  const setEpisodeWatched = async (series: TmdbSeriesDetails, episode: TmdbEpisode, watched: boolean) => {
    const progress = window.electron?.keepWatching
    if (!progress) {
      setSeriesError('Keep Watching bridge unavailable. Launch NetWatch through Electron.')
      return
    }
    setSeriesError(null)
    try {
      const result = watched
        ? await progress.markEpisodeWatched(toSeriesMediaItem(series, episode), Math.max(30, Number(episode.runtime || 0) * 60))
        : await progress.removeEpisode(`tv:${series.id}`, episode.season_number, episode.episode_number)
      await hydrateKeepWatching(result.state)
    } catch (error) {
      setSeriesError(getErrorMessage(error))
    }
  }

  const setSeasonWatched = async (series: TmdbSeriesDetails, episodes: TmdbEpisode[], watched: boolean) => {
    const progress = window.electron?.keepWatching
    if (!progress) throw new Error('Keep Watching is unavailable.')
    setSeriesError(null)
    let state: NetWatchKeepWatchingState | null = null
    for (const episode of episodes) {
      const result = watched
        ? await progress.markEpisodeWatched(toSeriesMediaItem(series, episode), Math.max(30, Number(episode.runtime || 0) * 60))
        : await progress.removeEpisode(`tv:${series.id}`, episode.season_number, episode.episode_number)
      state = result.state
    }
    if (state) await hydrateKeepWatching(state)
  }

  const playNextUnwatched = async (item: TmdbCatalogSummary) => {
    if (item.type === 'movie') { await playCatalogItem(item); return }
    setKeepWatchingOpening(`${item.type}:${item.id}`)
    setQuickPlayError(null)
    try {
      const series = await fetchSeriesDetails(item.id)
      const watched = new Set(episodeProgress.filter(record => record.catalog_id === `tv:${item.id}` && record.duration_seconds > 0 && record.position_seconds / record.duration_seconds >= 0.95)
        .map(record => `${record.season}:${record.episode}`))
      const seasons = (series.seasons || []).filter(season => season.season_number > 0 && season.episode_count > 0).sort((a, b) => a.season_number - b.season_number)
      for (const season of seasons) {
        const data = await fetchSeriesSeason(series.id, season.season_number)
        const episode = data.episodes.find(candidate => (!candidate.air_date || Date.parse(candidate.air_date) <= Date.now()) && !watched.has(`${candidate.season_number}:${candidate.episode_number}`))
        if (episode) { await playEpisodeAutomatically(series, episode); return }
      }
      throw new Error('Every available episode is marked watched.')
    } catch (error) {
      setQuickPlayError(getErrorMessage(error))
    } finally {
      setKeepWatchingOpening(null)
    }
  }

  const playCatalogItem = async (item: TmdbCatalogSummary) => {
    const bridge = window.electron?.player
    if (!bridge?.openTorrent || !runtime.ready || quickPlayBusy.current || opening) return
    const catalogId = `${item.type}:${item.id}`
    const requestId = ++quickPlayRequest.current
    quickPlayBusy.current = true
    const current = () => requestId === quickPlayRequest.current
    setKeepWatchingOpening(catalogId)
    setQuickPlayError(null)
    try {
      // Read progress at activation time; a card may have stayed visible while
      // playback on the phone updated the saved episode and position.
      const state = await window.electron!.keepWatching.getState()
      if (!current()) return
      const record = state.enabled ? state.items.find(entry => entry.catalog_id === catalogId) : undefined
      if (item.type === 'movie') {
        const data = await fetchMovieStreamOptions(item.id)
        if (!current()) return
        const selected = selectAutomaticResult(data.results, preferences.defaultQuality)
        if (!selected) throw new Error('No matching streams')
        await bridge.openTorrent({
          releaseRef: resultSource(selected),
          title: data.movie.title,
          mediaName: data.movie.title,
          expectedHash: selected.info_hash || null,
          mediaItem: toMediaItem(data.movie),
          resumePositionSeconds: record?.position_seconds,
        })
        return
      }

      if (record && (!Number.isInteger(record.season) || !Number.isInteger(record.episode))) {
        throw new Error('Saved episode is unavailable')
      }
      const series = await fetchSeriesDetails(item.id)
      if (!current()) return
      const today = new Date().toISOString().slice(0, 10)
      const seasonNumber = record?.season ?? [...(series.seasons || [])]
        .filter(season => season.season_number > 0 && season.episode_count > 0 && (!season.air_date || season.air_date <= today))
        .sort((a, b) => a.season_number - b.season_number)[0]?.season_number
      if (seasonNumber === undefined) throw new Error('No aired episodes available. Open Details to choose an episode.')
      const season = await fetchSeriesSeason(item.id, seasonNumber)
      if (!current()) return
      const episode = record ? season.episodes.find(entry => entry.episode_number === record.episode)
        : [...season.episodes].filter(entry => entry.episode_number > 0 && (!entry.air_date || entry.air_date <= today))
          .sort((a, b) => a.episode_number - b.episode_number)[0]
      if (!episode) throw new Error(record ? 'Saved episode is unavailable' : 'No aired episodes available')
      const data = await fetchEpisodeStreamOptions(series.id, seasonNumber, episode.episode_number, Boolean(series.is_anime || item.is_anime))
      if (!current()) return
      const selected = selectAutomaticResult(data.results, preferences.defaultQuality)
      if (!selected) throw new Error('No matching streams')
      const code = `S${String(seasonNumber).padStart(2, '0')}E${String(episode.episode_number).padStart(2, '0')}`
      await bridge.openTorrent({
        releaseRef: resultSource(selected),
        title: `${series.title} · ${code}${episode.name ? ` · ${episode.name}` : ''}`,
        mediaName: `${series.title} ${code}`,
        expectedHash: selected.info_hash || null,
        mediaItem: toSeriesMediaItem(series, episode),
        resumePositionSeconds: record?.position_seconds,
      })
    } catch (error) {
      if (current()) setQuickPlayError(getErrorMessage(error))
    } finally {
      if (current()) { quickPlayBusy.current = false; setKeepWatchingOpening(null) }
    }
  }

  const addQueueItem = (item: PlaybackQueueItem) => setPlaybackQueue(current => current.some(entry => entry.id === item.id) ? current : [...current, item])
  const queueCatalogItem = (item: TmdbCatalogSummary) => addQueueItem({
    id: `catalog:${item.type}:${item.id}`,
    title: item.title,
    subtitle: item.type === 'movie' ? 'Movie' : item.is_anime ? 'Anime series' : 'TV series',
    artwork: item.poster,
    play: () => playCatalogItem(item),
  })
  const playQueuedItem = (item: PlaybackQueueItem) => {
    setPlaybackQueue(current => current.filter(entry => entry.id !== item.id))
    void item.play()
  }
  const playHistoryEntry = async (entry: NetWatchViewingHistoryEntry) => {
    const item: TmdbCatalogSummary = { id: Number(entry.catalogId.split(':')[1]), type: entry.type, title: entry.title, year: entry.year, overview: '', poster: entry.poster, backdrop: entry.backdrop, rating: 0, is_anime: entry.isAnime }
    if (entry.type === 'movie') { await playCatalogItem(item); return }
    try {
      const series = await fetchSeriesDetails(item.id)
      const season = await fetchSeriesSeason(item.id, Number(entry.season))
      const episode = season.episodes.find(candidate => candidate.episode_number === entry.episode)
      if (!episode) throw new Error('This episode is unavailable.')
      await playEpisodeAutomatically(series, episode, entry.completed ? undefined : entry.lastPositionSeconds)
    } catch (error) { setQuickPlayError(getErrorMessage(error)) }
  }
  const moveQueueItem = (id: string, direction: -1 | 1) => setPlaybackQueue(current => {
    const items = [...current], index = items.findIndex(item => item.id === id), target = index + direction
    if (index < 0 || target < 0 || target >= items.length) return current
    ;[items[index], items[target]] = [items[target], items[index]]
    return items
  })

  const removeKeepWatchingEntry = async (entry: HydratedKeepWatchingItem) => {
    const api = window.electron?.keepWatching
    if (!api) {
      setKeepWatchingError('Keep Watching bridge unavailable. Launch NetWatch through Electron.')
      return
    }

    const catalogId = entry.record.catalog_id
    ++keepWatchingRequestId.current
    keepWatchingMetadata.current.delete(catalogId)
    setKeepWatchingItems(current => current.filter(item => item.record.catalog_id !== catalogId))
    setWatchRecords(current => current.filter(item => item.catalog_id !== catalogId))
    setKeepWatchingError(null)

    try {
      const result = await api.remove(catalogId)
      await hydrateKeepWatching(result.state)
    } catch (error) {
      setKeepWatchingError(getErrorMessage(error))
      try {
        await hydrateKeepWatching(await api.getState())
      } catch {
        // Keep the original removal error visible.
      }
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
    if (!['home', 'discover', 'search', 'settings', 'library', 'collections', 'history', 'queue', 'profile'].includes(next)) return
    cancelQuickPlay()
    const entry: NavigationEntry = next === 'search'
      ? { view: 'search', returnView: searchReturnView }
      : { view: next as SimpleNavigationView }
    if (!recordNavigation(entry)) {
      setDiagnosticsOpen(false)
      return
    }
    applyNavigationEntry(entry)
  }

  const navigateBack = () => {
    if (diagnosticsOpen) {
      setDiagnosticsOpen(false)
      return true
    }
    const target = navigationBack.current.pop()
    if (target) {
      navigationForward.current = [...navigationForward.current, captureNavigationEntry()].slice(-NAVIGATION_HISTORY_LIMIT)
      applyNavigationEntry(target)
      return true
    }
    if (view === 'movie' || view === 'series') {
      applyNavigationEntry(
        detailReturnView === 'search'
          ? { view: 'search', returnView: searchReturnView }
          : { view: detailReturnView },
      )
      return true
    }
    if (view === 'search') {
      applyNavigationEntry({ view: searchReturnView })
      return true
    }
    return false
  }

  const navigateForward = () => {
    if (diagnosticsOpen) {
      setDiagnosticsOpen(false)
      return true
    }
    const target = navigationForward.current.pop()
    if (!target) return false
    navigationBack.current = [...navigationBack.current, captureNavigationEntry()].slice(-NAVIGATION_HISTORY_LIMIT)
    applyNavigationEntry(target)
    return true
  }

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && (keepWatchingOpening || quickPlayError)) {
        event.preventDefault()
        cancelQuickPlay()
        return
      }
      if (event.key === 'Escape' && diagnosticsOpen) {
        event.preventDefault()
        setDiagnosticsOpen(false)
        return
      }
      if (event.key === 'Escape' && (view === 'movie' || view === 'series' || view === 'search')) {
        if (navigateBack()) event.preventDefault()
        return
      }
      if (event.altKey && event.key === 'ArrowLeft') {
        if (navigateBack()) event.preventDefault()
        return
      }
      if (event.altKey && event.key === 'ArrowRight') {
        if (navigateForward()) event.preventDefault()
        return
      }

      const target = event.target as HTMLElement | null
      const editing = Boolean(
        target?.isContentEditable ||
        target?.tagName === 'INPUT' ||
        target?.tagName === 'TEXTAREA' ||
        target?.tagName === 'SELECT'
      )
      const ctrlK = (event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k'
      const slash = event.key === '/' && !event.ctrlKey && !event.metaKey && !event.altKey && !editing
      if ((ctrlK || slash) && ['home', 'discover', 'settings', 'history', 'queue', 'profile', 'search'].includes(view)) {
        event.preventDefault()
        if (view === 'home') homeSearchRef.current?.focus()
        else if (view === 'discover') discoverSearchRef.current?.focus()
        else if (view === 'search') searchPageRef.current?.focus()
        else {
          const returnView: SearchReturnView = view === 'profile' ? 'profile' : view === 'history' ? 'history' : view === 'queue' ? 'queue' : 'settings'
          setSearchReturnView(returnView)
          const entry: NavigationEntry = { view: 'search', returnView }
          recordNavigation(entry)
          applyNavigationEntry(entry)
          window.setTimeout(() => searchPageRef.current?.focus(), 0)
        }
      }
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  })

  useEffect(() => {
    const handleMouseNavigation = (event: MouseEvent) => {
      const handled = event.button === 3
        ? navigateBack()
        : event.button === 4
          ? navigateForward()
          : false
      if (handled) event.preventDefault()
    }
    window.addEventListener('mouseup', handleMouseNavigation)
    return () => window.removeEventListener('mouseup', handleMouseNavigation)
  })

  const updatePreferences = (patch: Partial<NetWatchUiPreferences>) => {
    const next = { ...preferences, ...patch }
    const api = window.electron?.settings
    if (!api) {
      setPreferences(next)
      saveUiPreferences(next)
      setQualityFilter(next.defaultQuality)
      return
    }
    const localPatch: Partial<NetWatchUiPreferences> = {}
    if (patch.subtitleLanguage !== undefined) localPatch.subtitleLanguage = patch.subtitleLanguage
    if (patch.showStartupDetails !== undefined) localPatch.showStartupDetails = patch.showStartupDetails
    if (patch.homeLayout !== undefined) localPatch.homeLayout = patch.homeLayout
    if (patch.homeRailOrder !== undefined) localPatch.homeRailOrder = patch.homeRailOrder
    if (patch.hiddenHomeRails !== undefined) localPatch.hiddenHomeRails = patch.hiddenHomeRails
    if (patch.trackedSeriesNotifications !== undefined) localPatch.trackedSeriesNotifications = patch.trackedSeriesNotifications
    if (patch.interfaceScale !== undefined) localPatch.interfaceScale = patch.interfaceScale
    if (patch.contrastMode !== undefined) localPatch.contrastMode = patch.contrastMode
    if (patch.reducedMotion !== undefined) localPatch.reducedMotion = patch.reducedMotion
    if (patch.tvMode !== undefined) localPatch.tvMode = patch.tvMode
    if (Object.keys(localPatch).length) {
      setPreferences(current => {
        const localNext = { ...current, ...localPatch }
        saveUiPreferences(localNext)
        return localNext
      })
    }
    const mainPatch: Partial<Omit<NetWatchAppSettings, 'version'>> = {}
    if (patch.defaultQuality !== undefined) mainPatch.defaultQuality = patch.defaultQuality
    if (patch.onClose !== undefined) mainPatch.onClose = patch.onClose
    if (patch.startWithWindows !== undefined) mainPatch.startWithWindows = patch.startWithWindows
    if (patch.startMinimized !== undefined) mainPatch.startMinimized = patch.startMinimized
    if (patch.updateNotifications !== undefined) mainPatch.updateNotifications = patch.updateNotifications
    if (patch.keepWatchingEnabled !== undefined) mainPatch.keepWatchingEnabled = patch.keepWatchingEnabled
    if (patch.keepWatchingLimit !== undefined) mainPatch.keepWatchingLimit = patch.keepWatchingLimit
    if (patch.flareSolverrEnabled !== undefined) mainPatch.flareSolverrEnabled = patch.flareSolverrEnabled
    if (patch.resourceProfile !== undefined) mainPatch.resourceProfile = patch.resourceProfile
    if (patch.alwaysSkipIntro !== undefined) mainPatch.alwaysSkipIntro = patch.alwaysSkipIntro
    for (const key of Object.keys(PLAYBACK_DEFAULTS) as (keyof typeof PLAYBACK_DEFAULTS)[]) {
      if (patch[key] !== undefined) Object.assign(mainPatch, { [key]: patch[key] })
    }
    if (!Object.keys(mainPatch).length) return
    void api.update(mainPatch).then(result => {
      if (!result.cancelled) applyMainSettings(result.settings)
    }).catch(() => {})
  }

  const sidebarView: NetWatchView = view === 'search'
    ? searchReturnView
    : (view === 'movie' || view === 'series')
      ? (detailReturnView === 'search' ? searchReturnView : detailReturnView)
      : view
  const cinematicHome = preferences.homeLayout === 'cinematic'

  useEffect(() => {
    const root = document.documentElement
    root.dataset.nwScale = String(preferences.interfaceScale)
    root.dataset.nwContrast = preferences.contrastMode
    root.dataset.nwReducedMotion = String(preferences.reducedMotion)
    root.dataset.nwTv = String(preferences.tvMode)
  }, [preferences.interfaceScale, preferences.contrastMode, preferences.reducedMotion, preferences.tvMode])

  useDirectionalNavigation({
    arrowKeys: preferences.tvMode,
    navigationKey: `${view}:${diagnosticsOpen ? 'runtime' : 'main'}`,
    onBack: () => { navigateBack() },
    onForward: () => { navigateForward() },
    onMenu: () => document.querySelector<HTMLElement>('.nw-sidebar .nw-nav-button.is-active')?.focus(),
  })

  const renderHomeRail = (key: HomeRailKey) => {
    if (preferences.hiddenHomeRails.includes(key)) return null
    if (key === 'my-list') return localData.titles.length ? <HomeRail key={key} title="My List"
      items={localData.titles.map(item => ({ ...item, overview: '', rating: 0 }))} cinematic={cinematicHome}
      onSelect={item => loadCatalogItem(item, 'home')} onRemove={localCatalog.removeTitle} /> : null
    if (key === 'keep-watching') return preferences.keepWatchingEnabled && keepWatchingItems.length ? <KeepWatchingRail key={key}
      items={keepWatchingItems} openingCatalogId={keepWatchingOpening} cinematic={cinematicHome}
      onSelect={entry => void playCatalogItem(entry.item)} onRemove={entry => void removeKeepWatchingEntry(entry)} /> : null
    if (key === 'recommended') return recommendations.length ? <HomeRail key={key} title={recommendationTitle} items={recommendations}
      cinematic={cinematicHome} onSelect={item => loadCatalogItem(item, 'home')} /> : null
    const rails: Record<Exclude<HomeRailKey, 'my-list' | 'keep-watching' | 'recommended'>, [string, TmdbCatalogSummary[]]> = {
      'trending-movies': ['Trending Movies', home.movies], 'recent-movies': ['Recent Movies', home.recent_movies],
      'trending-tv': ['Trending TV', home.tv], 'recent-tv': ['Recent TV', home.recent_tv],
      'trending-anime': ['Trending Anime', home.anime], 'recent-anime': ['Recent Anime', home.recent_anime],
    }
    const [title, railItems] = rails[key]
    return <HomeRail key={key} title={title} items={railItems} loading={homeLoading && !homeLoaded} cinematic={cinematicHome} onSelect={item => loadCatalogItem(item, 'home')} />
  }

  return (
    <IconoirProvider iconProps={{ strokeWidth: 1.65 }}>
      <MotionConfig reducedMotion={preferences.reducedMotion ? 'always' : 'user'}>
      <CardActionsProvider navigationKey={view}
        canPlay={runtime.ready && !keepWatchingOpening && !opening}
        hasProgress={item => watchRecords.some(record => record.catalog_id === `${item.type}:${item.id}` && record.position_seconds > 0)}
        progressFor={item => {
          if (item.type !== 'tv') return null
          const record = episodeProgress.find(entry => entry.catalog_id === `tv:${item.id}`)
          return record && record.duration_seconds > 0 ? record.position_seconds / record.duration_seconds : null
        }}
        onPlay={item => void playCatalogItem(item)}
        onQueue={queueCatalogItem}
        onDetails={item => loadCatalogItem(item, view === 'discover' || view === 'search' || view === 'collections' || view === 'library' || view === 'history' || view === 'queue' || view === 'profile' ? view : 'home')}>
      <div className="nw-shell">
        <TitleBar />

        <div className="nw-workspace">
          <Sidebar
            view={sidebarView}
            runtime={runtime}
            runtimeOpen={diagnosticsOpen}
            onNavigate={navigate}
            onRuntimeClick={() => setDiagnosticsOpen(current => !current)}
          />

          <main className={`nw-content ${diagnosticsOpen ? 'has-drawer' : ''}`}>
            {(keepWatchingOpening || quickPlayError) && <div className={`nw-quick-play-popup${quickPlayError ? ' is-error' : ''}`} role={quickPlayError ? 'alert' : 'status'} aria-live={quickPlayError ? 'assertive' : 'polite'}>
              {keepWatchingOpening ? <RefreshCircle width={18} height={18} className="nw-spin" /> : <WarningTriangle width={18} height={18} />}
              <span>{keepWatchingOpening ? 'Finding streams…' : quickPlayError}</span>
              <button type="button" className="nw-icon-button" aria-label={keepWatchingOpening ? 'Cancel playback search' : 'Dismiss'} onClick={cancelQuickPlay}><Xmark width={17} height={17} /></button>
            </div>}
            {keepWatchingError && <div className="nw-inline-notice compact nw-local-data-error is-error" role="alert">
              <WarningTriangle width={18} height={18} />
              <div>{keepWatchingError}</div>
              <button type="button" onClick={() => setKeepWatchingError(null)}>Dismiss</button>
            </div>}
            {localData.error && (
              <div className="nw-inline-notice is-error compact nw-local-data-error" role="alert">
                <WarningTriangle width={18} height={18} />
                <div><strong>Local data unavailable</strong><p>{localData.error}</p></div>
                <button type="button" onClick={localCatalog.dismissError}>Dismiss</button>
              </div>
            )}
            {view === 'home' ? (
              <motion.section
                className="nw-view nw-home-view"
                key="home"
                initial={{ opacity: 0, y: 4 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ duration: 0.16 }}
              >
                <header className="nw-catalog-topbar nw-home-topbar">
                  <div className="nw-home-toolbar">
                    <SearchBar
                      query={query}
                      runtimeReady={runtime.ready}
                      searching={searching}
                      inputRef={homeSearchRef}
                      onQueryChange={setQuery}
                      onSubmit={runSearch}
                    />
                    <button
                      type="button"
                      className={`nw-home-layout-toggle${cinematicHome ? ' is-active' : ''}`}
                      aria-label={cinematicHome ? 'Use standard Home layout' : 'Use cinematic Home layout'}
                      aria-pressed={cinematicHome}
                      title={cinematicHome ? 'Standard layout' : 'Cinematic layout'}
                      onClick={() => updatePreferences({ homeLayout: cinematicHome ? 'standard' : 'cinematic' })}
                    >
                      <span className="nw-home-layout-toggle__glyph" aria-hidden="true"><i /><i /></span>
                    </button>
                  </div>
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

                <div className={`nw-home-feed${cinematicHome ? ' is-cinematic' : ''}`}>
                  {preferences.homeRailOrder.map(renderHomeRail)}
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
            ) : view === 'collections' ? (
              <CollectionsView initialCollection={collectionSelection} onSelect={item => loadCatalogItem(item, 'collections')} />
            ) : view === 'library' ? (
              <LibraryView runtimeReady={runtime.ready} onDetails={item => loadCatalogItem(item, 'library')} onQueue={item => addQueueItem({
                id: `local:${item.id}`, title: item.match?.title || item.episode?.series || item.filename,
                subtitle: item.episode ? `Local · S${item.episode.season}E${item.episode.episode}` : 'Local file', artwork: item.match?.poster || null,
                play: () => window.electron?.library.play(item.id),
              })} />
            ) : view === 'settings' ? (
              <SettingsView
                preferences={preferences}
                onChange={updatePreferences}
                onOpenDiagnostics={() => setDiagnosticsOpen(true)}
              />
            ) : view === 'history' ? (
              <HistoryView
                onDetails={item => loadCatalogItem(item, 'history')}
                onPlay={entry => void playHistoryEntry(entry)}
              />
            ) : view === 'queue' ? (
              <QueueView items={playbackQueue} onPlay={playQueuedItem}
                onRemove={id => setPlaybackQueue(current => current.filter(item => item.id !== id))}
                onMove={moveQueueItem} onClear={() => setPlaybackQueue([])} />
            ) : view === 'profile' ? (
              <ProfilePage
                onSelect={item => loadCatalogItem(item, 'profile')}
                onPlay={item => void playCatalogItem(item)}
                onPlayNext={item => void playNextUnwatched(item)}
                onNavigate={navigate}
                onOpenCollection={id => { setCollectionSelection(id); navigate('collections') }}
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
                onBack={() => { navigateBack() }}
                onRetry={retryMovie}
                onPlay={(result, movie) => void playMovieResult(result, movie)}
              />
            ) : view === 'series' && selectedSeries ? (
              <SeriesDetailsView
                key={`series-${selectedSeries.id}`}
                seedSeries={selectedSeries}
                details={seriesData}
                loading={seriesLoading}
                error={seriesError}
                openingSource={opening}
                qualityFilter={qualityFilter}
                sortMode={sortMode}
                anime={selectedSeriesAnime}
                episodeProgress={episodeProgress}
                onQualityFilter={setQualityFilter}
                onSortMode={setSortMode}
                onBack={() => { navigateBack() }}
                onRetry={retrySeries}
                onPlay={(result, series, episode, resumePositionSeconds) => void playEpisodeResult(result, series, episode, resumePositionSeconds)}
                onPlayFromBeginning={playEpisodeFromBeginning}
                onPlayNow={(series, episode, resumePositionSeconds) => playEpisodeAutomatically(series, episode, resumePositionSeconds)}
                onSetWatched={setEpisodeWatched}
                onSetSeasonWatched={setSeasonWatched}
                onPlayNextUnwatched={series => void playNextUnwatched(series)}
                onQueueEpisode={(series, episode) => addQueueItem({
                  id: `episode:${series.id}:${episode.season_number}:${episode.episode_number}`,
                  title: series.title,
                  subtitle: `S${String(episode.season_number).padStart(2, '0')}E${String(episode.episode_number).padStart(2, '0')} · ${episode.name}`,
                  artwork: episode.still || series.poster,
                  play: () => playEpisodeAutomatically(series, episode),
                })}
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
      </CardActionsProvider>
      </MotionConfig>
    </IconoirProvider>
  )
}
