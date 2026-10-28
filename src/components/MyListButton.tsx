import { Eye, EyeClosed, Minus, Plus } from 'iconoir-react'
import type { TmdbCatalogSummary } from '../types/metadata'
import { localCatalog, useLocalCatalog } from '../store/localCatalog'
import { titleKey } from '../utils/localCatalog'
import { AddToCollection } from './AddToCollection'

export function MyListButton({ item }: { item: TmdbCatalogSummary }) {
  const { titles, collections } = useLocalCatalog()
  const saved = titles.some(entry => titleKey(entry) === titleKey(item))
  const watched = collections.watched.includes(titleKey(item))
  return (
    <div className="nw-title-list-actions">
    <button
      type="button"
      className="nw-icon-button"
      aria-pressed={saved}
      aria-label={saved ? 'Remove from My List' : 'Add to My List'}
      title={saved ? 'Remove from My List' : 'Add to My List'}
      onClick={() => localCatalog.toggleTitle(item)}
    >
      {saved ? <Minus width={20} height={20} /> : <Plus width={20} height={20} />}
    </button>
    <button type="button" className="nw-icon-button" aria-pressed={watched}
      aria-label={watched ? 'Mark as Unwatched' : 'Mark as Watched'}
      title={watched ? 'Mark as Unwatched' : 'Mark as Watched'} onClick={() => localCatalog.toggleWatched(item)}>
      {watched ? <EyeClosed width={20} height={20} /> : <Eye width={20} height={20} />}
    </button>
    <AddToCollection key={titleKey(item)} item={item} />
    </div>
  )
}
