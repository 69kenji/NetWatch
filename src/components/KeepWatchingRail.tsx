import { useRef } from 'react'
import { NavArrowLeft, NavArrowRight } from 'iconoir-react'
import { CatalogCard } from './CatalogCard'
import type { TmdbCatalogSummary } from '../types/metadata'

export type HydratedKeepWatchingItem = {
  record: NetWatchKeepWatchingItem
  item: TmdbCatalogSummary
}

type Props = {
  items: HydratedKeepWatchingItem[]
  openingCatalogId?: string | null
  onSelect: (item: HydratedKeepWatchingItem) => void
}

function statusText(record: NetWatchKeepWatchingItem) {
  const watched = new Date(record.updated_at)
  const timestamp = Number.isFinite(watched.getTime())
    ? watched.toLocaleString([], { dateStyle: 'short', timeStyle: 'short' })
    : ''
  const episode = Number.isInteger(record.season) && Number.isInteger(record.episode)
    ? `S${String(record.season).padStart(2, '0')}E${String(record.episode).padStart(2, '0')}`
    : ''
  return [episode, timestamp].filter(Boolean).join(' · ')
}

export function KeepWatchingRail({ items, openingCatalogId = null, onSelect }: Props) {
  const railRef = useRef<HTMLDivElement>(null)
  const scrollByPage = (direction: -1 | 1) => {
    const rail = railRef.current
    if (rail) rail.scrollBy({ left: direction * Math.max(420, rail.clientWidth * 0.72), behavior: 'smooth' })
  }

  return (
    <section className="nw-discovery-row" aria-label="Keep Watching">
      <header className="nw-discovery-row__header">
        <h2>Keep Watching</h2>
        <div className="nw-discovery-row__controls" aria-label="Keep Watching controls">
          <button type="button" onClick={() => scrollByPage(-1)} aria-label="Scroll Keep Watching left"><NavArrowLeft width={16} height={16} /></button>
          <button type="button" onClick={() => scrollByPage(1)} aria-label="Scroll Keep Watching right"><NavArrowRight width={16} height={16} /></button>
        </div>
      </header>
      <div className="nw-discovery-rail" ref={railRef}>
        {items.map(entry => (
          <CatalogCard
            key={entry.record.catalog_id}
            item={entry.item}
            progress={entry.record.duration_seconds > 0 ? entry.record.position_seconds / entry.record.duration_seconds : 0}
            status={statusText(entry.record)}
            busy={openingCatalogId === entry.record.catalog_id}
            onSelect={() => onSelect(entry)}
          />
        ))}
      </div>
    </section>
  )
}
