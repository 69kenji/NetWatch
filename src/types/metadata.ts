import type { MediaItem } from '../store'
import type { TorrentSearchResult } from './torrents'

export type CatalogKind = 'movies' | 'series' | 'anime'
export type DiscoverMedia = 'movies' | 'tv' | 'anime'
export type DiscoverCategory = 'popular' | 'new' | 'featured'
export type TmdbGenre = { id: number; name: string }
type TmdbMediaType = 'movie' | 'tv'

export type TmdbCatalogSummary = {
  id: number
  type: TmdbMediaType
  title: string
  original_title?: string | null
  year: string
  release_date?: string | null
  overview: string
  poster: string | null
  backdrop: string | null
  rating: number
  vote_count?: number
  popularity?: number
  original_language?: string | null
  origin_country?: string[]
  is_anime?: boolean
}

export type TmdbHomePayload = {
  movies: TmdbCatalogSummary[]
  recent_movies: TmdbCatalogSummary[]
  tv: TmdbCatalogSummary[]
  recent_tv: TmdbCatalogSummary[]
  anime: TmdbCatalogSummary[]
  recent_anime: TmdbCatalogSummary[]
}

export type TmdbMovieSummary = TmdbCatalogSummary & {
  type: 'movie'
}

export type TmdbSeriesSummary = TmdbCatalogSummary & {
  type: 'tv'
}

type TmdbCastMember = {
  name: string
  character: string
  photo?: string | null
}

export type TmdbMovieDetails = TmdbMovieSummary & {
  player_backdrop?: string | null
  logo?: string | null
  tagline?: string
  runtime?: number | null
  genres?: string[]
  imdb_id?: string | null
  status?: string | null
  cast?: TmdbCastMember[]
}

type TmdbSeasonSummary = {
  id: number
  season_number: number
  name: string
  episode_count: number
  air_date?: string | null
  overview?: string
  poster?: string | null
}

export type TmdbEpisode = {
  id: number
  season_number: number
  episode_number: number
  name: string
  overview: string
  air_date?: string | null
  runtime?: number | null
  rating: number
  still?: string | null
  imdb_id?: string | null
}

export type TmdbSeasonDetails = {
  id: number
  season_number: number
  name: string
  overview: string
  air_date?: string | null
  poster?: string | null
  episodes: TmdbEpisode[]
}

export type TmdbSeriesDetails = TmdbSeriesSummary & {
  player_backdrop?: string | null
  logo?: string | null
  tagline?: string
  genres?: string[]
  imdb_id?: string | null
  status?: string | null
  last_air_date?: string | null
  number_of_seasons?: number
  number_of_episodes?: number
  episode_run_time?: number[]
  networks?: string[]
  seasons?: TmdbSeasonSummary[]
  cast?: TmdbCastMember[]
}

export type MovieStreamOptions = {
  movie: TmdbMovieDetails
  query: string
  results: TorrentSearchResult[]
  release_error?: { service?: string; error?: string } | null
}

export type EpisodeStreamOptions = {
  series: TmdbSeriesDetails
  episode: TmdbEpisode
  query: string
  query_attempts?: string[]
  results: TorrentSearchResult[]
  release_error?: { service?: string; error?: string } | null
  anime?: boolean
}

export function toMediaItem(movie: TmdbMovieDetails | TmdbMovieSummary): MediaItem {
  return {
    id: movie.id,
    tmdb_id: movie.id,
    type: 'movie',
    title: movie.title,
    year: movie.year || '',
    overview: movie.overview || '',
    poster: movie.poster || null,
    backdrop: movie.backdrop || null,
    backdrop_original: 'player_backdrop' in movie ? movie.player_backdrop || null : null,
    logo: 'logo' in movie ? movie.logo || null : null,
    rating: Number(movie.rating || 0),
    ...('imdb_id' in movie && movie.imdb_id ? { imdb_id: movie.imdb_id } : {}),
  }
}

export function toSeriesMediaItem(series: TmdbSeriesDetails, episode: TmdbEpisode): MediaItem {
  return {
    id: series.id,
    tmdb_id: series.id,
    type: 'tv',
    title: series.title,
    year: series.year || '',
    overview: episode.overview || series.overview || '',
    poster: series.poster || null,
    backdrop: series.backdrop || null,
    backdrop_original: series.player_backdrop || null,
    logo: series.logo || null,
    rating: Number(series.rating || 0),
    imdb_id: series.imdb_id || undefined,
    season: episode.season_number,
    episode: episode.episode_number,
    episode_title: episode.name,
  }
}
