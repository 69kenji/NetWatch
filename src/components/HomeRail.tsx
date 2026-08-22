import { useRef } from 'react'
import { NavArrowLeft, NavArrowRight } from 'iconoir-react'
import { CatalogCard } from './CatalogCard'
import type { TmdbCatalogSummary } from '../types/metadata'

type Props = {
  title: string
  items: TmdbCatalogSummary[]
  loading?: boolean
  onSelect: (item: TmdbCatalogSummary) => void
}

export function HomeRail({ title, items, loading = false, onSelect }: Props) {
  const railRef = useRef<HTMLDivElement>(null)

  const scrollByPage = (direction: -1 | 1) => {
    const rail = railRef.current
    if (!rail) return
    rail.scrollBy({ left: direction * Math.max(420, rail.clientWidth * 0.72), behavior: 'smooth' })
  }

  return (
    <section className="nw-discovery-row" aria-label={title}>
      <header className="nw-discovery-row__header">
        <h2>{title}</h2>
        <div className="nw-discovery-row__controls" aria-label={`${title} controls`}>
          <button type="button" onClick={() => scrollByPage(-1)} aria-label={`Scroll ${title} left`}>
            <NavArrowLeft width={16} height={16} />
          </button>
          <button type="button" onClick={() => scrollByPage(1)} aria-label={`Scroll ${title} right`}>
            <NavArrowRight width={16} height={16} />
          </button>
        </div>
      </header>

      <div className="nw-discovery-rail" ref={railRef}>
        {loading
          ? Array.from({ length: 8 }).map((_, index) => <span className="nw-discovery-skeleton" key={index} />)
          : items.map(item => (
              <CatalogCard
                key={`${item.type}-${item.id}`}
                item={item}
                onSelect={() => onSelect(item)}
              />
            ))}
      </div>
    </section>
  )
}
