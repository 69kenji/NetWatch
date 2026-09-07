import { motion } from 'framer-motion'
import type { TmdbCatalogSummary } from '../types/metadata'

interface CatalogCardProps {
  item: TmdbCatalogSummary
  onSelect: () => void
  progress?: number | null
  status?: string | null
  busy?: boolean
  variant?: 'poster' | 'cinematic'
}

function kindLabel(item: TmdbCatalogSummary) {
  if (item.is_anime) return 'Anime'
  return item.type === 'movie' ? 'Movie' : 'TV'
}

export function CatalogCard({
  item,
  onSelect,
  progress = null,
  status = null,
  busy = false,
  variant = 'poster',
}: CatalogCardProps) {
  const artwork = variant === 'cinematic' ? item.backdrop || item.poster : item.poster

  return (
    <motion.button
      type="button"
      className={`nw-movie-card nw-catalog-card${variant === 'cinematic' ? ' is-cinematic' : ''}`}
      onClick={onSelect}
      disabled={busy}
      whileHover={{ y: -2 }}
      transition={{ duration: 0.14 }}
      aria-label={`Open ${item.title}${item.year ? ` (${item.year})` : ''}`}
    >
      <div className="nw-movie-card__poster">
        {artwork ? (
          <img src={artwork} alt="" loading="lazy" />
        ) : (
          <div className="nw-movie-card__poster-fallback" aria-hidden="true">
            <span>NW</span>
          </div>
        )}
        <span className="nw-catalog-card__kind">{kindLabel(item)}</span>
        {progress != null ? (
          <span className="nw-keep-watching-progress" aria-label={`${Math.round(progress * 100)}% watched`}>
            <span style={{ width: `${Math.max(0, Math.min(100, progress * 100))}%` }} />
          </span>
        ) : null}
      </div>
      <div className="nw-movie-card__copy">
        <strong>{item.title}</strong>
        <span>{[item.year, item.original_language?.toUpperCase()].filter(Boolean).join(' · ') || kindLabel(item)}</span>
        {status ? <small className="nw-keep-watching-status">{status}</small> : null}
      </div>
    </motion.button>
  )
}
