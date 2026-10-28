import { useState } from 'react'
import { BookStack, Check, Eye, Plus } from 'iconoir-react'
import type { TmdbCatalogSummary } from '../types/metadata'
import { localCatalog, useLocalCatalog } from '../store/localCatalog'
import { titleKey } from '../utils/localCatalog'
import { ActionMenu } from './ActionMenu'

export function AddToCollection({ item }: { item: TmdbCatalogSummary }) {
  const { titles, collections } = useLocalCatalog()
  const [anchor, setAnchor] = useState<{ x: number; y: number; trigger: HTMLButtonElement } | null>(null)
  const key = titleKey(item)
  const options = [
    { id: 'my-list', name: 'My List', included: titles.some(entry => titleKey(entry) === key), icon: Plus },
    { id: 'watched', name: 'Watched', included: collections.watched.includes(key), icon: Eye },
    ...collections.groups.map(group => ({ ...group, included: group.keys.includes(key), icon: BookStack })),
  ]
  const add = (id: string) => {
    // Read current membership before acting; adding an existing title is a no-op.
    const current = localCatalog.getSnapshot()
    if (id === 'my-list') {
      if (!current.titles.some(entry => titleKey(entry) === key)) localCatalog.toggleTitle(item)
    } else if (id === 'watched') {
      if (!current.collections.watched.includes(key)) localCatalog.toggleWatched(item)
    } else localCatalog.setCollectionTitle(id, item, true)
    setAnchor(null)
    if (anchor?.trigger.isConnected) anchor.trigger.focus({ preventScroll: true })
  }
  return <>
    <button type="button" className="btn btn-ghost nw-compact-button" aria-label="Add to collection" title="Add to collection"
      aria-haspopup="menu" aria-expanded={Boolean(anchor)} onClick={event => {
        const trigger = event.currentTarget
        const bounds = trigger.getBoundingClientRect()
        setAnchor(anchor ? null : { x: bounds.left, y: bounds.bottom + 4, trigger })
      }}><BookStack width={18} height={18} />Add to</button>
    {anchor && <ActionMenu {...anchor} label="Add to collection" toggleTrigger onClose={() => setAnchor(null)}>
      {options.map(option => {
        const Icon = option.included ? Check : option.icon
        return <button key={option.id} type="button" role="menuitem" disabled={option.included}
          title={option.included ? `Already in ${option.name}` : option.name} onClick={() => add(option.id)}>
          <Icon width={17} height={17} /><span>{option.name}</span>
        </button>
      })}
    </ActionMenu>}
  </>
}
