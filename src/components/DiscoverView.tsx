import { motion } from 'framer-motion'
import { RefreshCircle, Search, WarningTriangle } from 'iconoir-react'
import type { FormEvent, RefObject } from 'react'
import { CatalogCard } from './CatalogCard'
import { SearchBar } from './SearchBar'
import type {
  DiscoverCategory,
  DiscoverMedia,
  TmdbCatalogSummary,
  TmdbGenre,
} from '../types/metadata'

type Props = {
  query: string
  runtimeReady: boolean
  searching: boolean
  searchInputRef?: RefObject<HTMLInputElement>
  onQueryChange: (value: string) => void
  onSearch: (event?: FormEvent) => void
  media: DiscoverMedia
  category: DiscoverCategory
  genreId: number | null
  genres: TmdbGenre[]
  items: TmdbCatalogSummary[]
  loading: boolean
  error: string | null
  onMediaChange: (value: DiscoverMedia) => void
  onCategoryChange: (value: DiscoverCategory) => void
  onGenreChange: (value: number | null) => void
  onRetry: () => void
  onSelect: (item: TmdbCatalogSummary) => void
}

const MEDIA_LABELS: Record<DiscoverMedia, string> = {
  movies: 'Movies',
  tv: 'TV',
  anime: 'Anime',
}

const CATEGORY_LABELS: Record<DiscoverCategory, string> = {
  popular: 'Popular',
  new: 'New',
  featured: 'Featured',
}

export function DiscoverView({
  query,
  runtimeReady,
  searching,
  searchInputRef,
  onQueryChange,
  onSearch,
  media,
  category,
  genreId,
  genres,
  items,
  loading,
  error,
  onMediaChange,
  onCategoryChange,
  onGenreChange,
  onRetry,
  onSelect,
}: Props) {
  const genreLabel = genreId == null ? 'Top' : genres.find(item => item.id === genreId)?.name || 'Genre'

  return (
    <motion.section
      className="nw-view nw-discover-view"
      key="discover"
      initial={{ opacity: 0, y: 4 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.16 }}
    >
      <header className="nw-catalog-topbar">
        <SearchBar
          query={query}
          runtimeReady={runtimeReady}
          searching={searching}
          inputRef={searchInputRef}
          onQueryChange={onQueryChange}
          onSubmit={onSearch}
        />
      </header>

      <div className="nw-discover-body">
        <div className="nw-discover-controls" aria-label="Discover filters">
          <label>
            <span>Catalog</span>
            <select value={media} onChange={event => onMediaChange(event.target.value as DiscoverMedia)}>
              <option value="movies">Movies</option>
              <option value="tv">TV</option>
              <option value="anime">Anime</option>
            </select>
          </label>

          <label>
            <span>Category</span>
            <select value={category} onChange={event => onCategoryChange(event.target.value as DiscoverCategory)}>
              <option value="popular">Popular</option>
              <option value="new">New</option>
              <option value="featured">Featured</option>
            </select>
          </label>

          <label>
            <span>Genre</span>
            <select
              value={genreId == null ? 'top' : String(genreId)}
              onChange={event => onGenreChange(event.target.value === 'top' ? null : Number(event.target.value))}
            >
              <option value="top">Top</option>
              {genres.map(genre => <option key={genre.id} value={genre.id}>{genre.name}</option>)}
            </select>
          </label>
        </div>

        {error && (
          <div className="nw-inline-notice is-error compact nw-discover-notice">
            <WarningTriangle width={18} height={18} />
            <div><strong>Discover unavailable</strong><p>{error}</p></div>
            <button type="button" onClick={onRetry}><RefreshCircle width={16} height={16} /> Retry</button>
          </div>
        )}

        <section className="nw-results-section nw-discover-results" aria-live="polite">
          <div className="nw-results-toolbar nw-discover-results__header">
            <h2>{loading ? 'Loading' : `${items.length} titles`}</h2>
            <span>{MEDIA_LABELS[media]} · {CATEGORY_LABELS[category]} · {genreLabel}</span>
          </div>

          {loading && (
            <div className="nw-movie-skeleton-grid" aria-label="Loading discover titles">
              {Array.from({ length: 18 }).map((_, index) => <span key={index} className="nw-movie-skeleton" />)}
            </div>
          )}

          {!loading && !error && items.length === 0 && (
            <div className="nw-empty-state">
              <div className="nw-empty-state__icon"><Search width={28} height={28} /></div>
              <strong>No titles in this selection</strong>
              <span>Try another category or genre.</span>
            </div>
          )}

          {!loading && items.length > 0 && (
            <div className="nw-movie-grid">
              {items.map(item => (
                <CatalogCard
                  key={`${item.type}-${item.id}`}
                  item={item}
                  onSelect={() => onSelect(item)}
                />
              ))}
            </div>
          )}

          {!loading && items.length > 0 && <p className="nw-tmdb-credit nw-tmdb-credit--search">Metadata · TMDB</p>}
        </section>
      </div>
    </motion.section>
  )
}
