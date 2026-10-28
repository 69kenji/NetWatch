import { MediaVideoList, NavArrowDown, NavArrowUp, Play, Trash, Xmark } from 'iconoir-react'

export type PlaybackQueueItem = {
  id: string
  title: string
  subtitle: string
  artwork: string | null
  play: () => void | Promise<unknown>
}

export function QueueView({ items, onRemove, onMove, onClear, onPlay }: {
  items: PlaybackQueueItem[]
  onRemove: (id: string) => void
  onMove: (id: string, direction: -1 | 1) => void
  onClear: () => void
  onPlay: (item: PlaybackQueueItem) => void
}) {
  return <section className="nw-view nw-queue-view">
    <header className="nw-settings-header"><div><h1>Queue</h1><p>Play in this order.</p></div>
      {!!items.length && <button className="btn btn-ghost nw-compact-button" onClick={onClear}><Trash width={16} />Clear</button>}
    </header>
    {!items.length && <div className="nw-queue-empty"><MediaVideoList width={24} /><div><strong>Your queue is empty</strong><span>Add a title, episode, or local file from its menu.</span></div></div>}
    <div className="nw-queue-list">{items.map((item, index) => <article className="nw-queue-entry" key={item.id}>
      <button className="nw-queue-play" onClick={() => onPlay(item)}>
        {item.artwork ? <img src={item.artwork} alt="" /> : <span>NW</span>}
        <span><strong>{item.title}</strong><small>{item.subtitle}</small></span><Play width={18} />
      </button>
      <div className="nw-compact-actions">
        <button className="nw-icon-button" disabled={index === 0} title="Move up" aria-label={`Move ${item.title} up`} onClick={() => onMove(item.id, -1)}><NavArrowUp width={17} /></button>
        <button className="nw-icon-button" disabled={index === items.length - 1} title="Move down" aria-label={`Move ${item.title} down`} onClick={() => onMove(item.id, 1)}><NavArrowDown width={17} /></button>
        <button className="nw-icon-button" title="Remove" aria-label={`Remove ${item.title} from queue`} onClick={() => onRemove(item.id)}><Xmark width={18} /></button>
      </div>
    </article>)}</div>
  </section>
}
