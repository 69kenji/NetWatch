import { motion } from 'framer-motion'
import type { TmdbCatalogSummary } from '../types/metadata'

interface CatalogCardProps {
  item: TmdbCatalogSummary
  onSelect: () => void
}

function kindLabel(item: TmdbCatalogSummary) {
  if (item.is_anime) return 'Anime'
  return item.type === 'movie' ? 'Movie' : 'TV'
}

export function CatalogCard({ item, onSelect }: CatalogCardProps) {
  return (
    <motion.button
      type="button"
      className="nw-movie-card nw-catalog-card"
      onClick={onSelect}
      whileHover={{ y: -2 }}
      transition={{ duration: 0.14 }}
      aria-label={`Open ${item.title}${item.year ? ` (${item.year})` : ''}`}
    >
      <div className="nw-movie-card__poster">
        {item.poster ? (
          <img src={item.poster} alt="" loading="lazy" />
        ) : (
          <div className="nw-movie-card__poster-fallback" aria-hidden="true">
            <span>NW</span>
          </div>
        )}
        <span className="nw-catalog-card__kind">{kindLabel(item)}</span>
      </div>
      <div className="nw-movie-card__copy">
        <strong>{item.title}</strong>
        <span>{[item.year, item.original_language?.toUpperCase()].filter(Boolean).join(' · ') || kindLabel(item)}</span>
      </div>
    </motion.button>
  )
}
