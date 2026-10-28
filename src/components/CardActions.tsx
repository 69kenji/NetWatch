import { createContext, useContext, useEffect, useState, type ReactNode } from 'react'
import { BookStack, Check, Eye, EyeClosed, InfoCircle, Minus, NavArrowLeft, Play, PlaylistPlus, Plus } from 'iconoir-react'
import type { TmdbCatalogSummary } from '../types/metadata'
import { localCatalog, useLocalCatalog } from '../store/localCatalog'
import { titleKey } from '../utils/localCatalog'
import { ActionMenu } from './ActionMenu'

type MenuRequest = {
  x: number
  y: number
  trigger: HTMLElement
  title: string
  item?: TmdbCatalogSummary
  resume: boolean
  playDisabled: boolean
  play: () => void
  details: () => void
  queue?: () => void
}
type CardActions = {
  open: (request: MenuRequest) => void
  openCatalog: (item: TmdbCatalogSummary, trigger: HTMLElement, x: number, y: number) => void
  progressFor: (item: TmdbCatalogSummary) => number | null
}
const Context = createContext<CardActions | null>(null)
export const useCardActions = () => useContext(Context)

export function CardActionsProvider({ children, canPlay, hasProgress, progressFor, onPlay, onDetails, onQueue, navigationKey }: {
  children: ReactNode
  canPlay: boolean
  hasProgress: (item: TmdbCatalogSummary) => boolean
  progressFor: (item: TmdbCatalogSummary) => number | null
  onPlay: (item: TmdbCatalogSummary) => void
  onDetails: (item: TmdbCatalogSummary) => void
  onQueue: (item: TmdbCatalogSummary) => void
  navigationKey: string
}) {
  const [menu, setMenu] = useState<MenuRequest | null>(null)
  useEffect(() => setMenu(null), [navigationKey])
  return <Context.Provider value={{
    open: setMenu,
    openCatalog: (item, trigger, x, y) => setMenu({
      x, y, trigger, title: item.title, item, resume: hasProgress(item), playDisabled: !canPlay,
      play: () => onPlay(item), details: () => onDetails(item), queue: () => onQueue(item),
    }),
    progressFor,
  }}>
    {children}
    {menu && <CardMenu key={`${menu.title}:${menu.x}:${menu.y}`} menu={menu} onClose={() => setMenu(null)} />}
  </Context.Provider>
}

function CardMenu({ menu, onClose }: { menu: MenuRequest; onClose: () => void }) {
  const { titles, collections } = useLocalCatalog()
  const [collectionOpen, setCollectionOpen] = useState(false)
  const item = menu.item
  const saved = item && titles.some(entry => titleKey(entry) === titleKey(item))
  const watched = item && collections.watched.includes(titleKey(item))
  const activate = (action: () => void) => {
    onClose()
    if (menu.trigger.isConnected) menu.trigger.focus({ preventScroll: true })
    action()
  }
  return <ActionMenu {...menu} label={collectionOpen ? `Add ${menu.title} to collection` : menu.title} onClose={onClose}>
    {collectionOpen ? <>
      <button type="button" role="menuitem" onClick={() => setCollectionOpen(false)}><NavArrowLeft width={17} /><span>Back</span></button>
      {collections.groups.map(group => {
        const included = Boolean(item && group.keys.includes(titleKey(item)))
        return <button key={group.id} type="button" role="menuitem" disabled={!item || included}
          onClick={() => item && activate(() => localCatalog.setCollectionTitle(group.id, item, true))}>
          {included ? <Check width={17} /> : <BookStack width={17} />}<span>{included ? `In ${group.name}` : group.name}</span>
        </button>
      })}
      {!collections.groups.length && <p className="nw-card-menu__empty">Create a collection first.</p>}
    </> : <>
    <button type="button" role="menuitem" disabled={menu.playDisabled} onClick={() => activate(menu.play)}>
      <Play width={17} height={17} /><span>{menu.resume ? 'Keep playing' : 'Play now'}</span>
    </button>
    <button type="button" role="menuitem" onClick={() => activate(menu.details)}>
      <InfoCircle width={17} height={17} /><span>Details</span>
    </button>
    {menu.queue && <button type="button" role="menuitem" onClick={() => activate(menu.queue!)}><PlaylistPlus width={17} /><span>Add to queue</span></button>}
    <button type="button" role="menuitem" disabled={!item} title={!item ? 'Match this file to a title first' : undefined}
      onClick={() => item && activate(() => localCatalog.toggleTitle(item))}>
      {saved ? <Minus width={17} height={17} /> : <Plus width={17} height={17} />}<span>{saved ? 'Remove from My List' : 'Add to My List'}</span>
    </button>
    <button type="button" role="menuitem" disabled={!item} title={!item ? 'Match this file to a title first' : undefined}
      onClick={() => item && activate(() => localCatalog.toggleWatched(item))}>
      {watched ? <EyeClosed width={17} height={17} /> : <Eye width={17} height={17} />}<span>{watched ? 'Mark as Unwatched' : 'Mark as Watched'}</span>
    </button>
    <button type="button" role="menuitem" disabled={!item} title={!item ? 'Match this file to a title first' : undefined}
      onClick={() => setCollectionOpen(true)}><BookStack width={17} /><span>Add to collection</span></button>
    </>}
  </ActionMenu>
}
