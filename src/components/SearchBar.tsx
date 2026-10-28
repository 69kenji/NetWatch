import { useId, useRef, useState, type FormEvent, type RefObject } from 'react'
import { Clock, RefreshCircle, Search, Xmark } from 'iconoir-react'
import { localCatalog, useLocalCatalog } from '../store/localCatalog'

type SearchBarProps = {
  query: string
  runtimeReady: boolean
  searching: boolean
  inputRef?: RefObject<HTMLInputElement>
  onQueryChange: (value: string) => void
  onSubmit: (event?: FormEvent, directQuery?: string) => void
}

export function SearchBar({ query, runtimeReady, searching, inputRef, onQueryChange, onSubmit }: SearchBarProps) {
  const { queries, historyEnabled } = useLocalCatalog()
  const [focused, setFocused] = useState(false)
  const fallbackInputRef = useRef<HTMLInputElement>(null)
  const fieldRef = inputRef || fallbackInputRef
  const formRef = useRef<HTMLFormElement>(null)
  const panelId = useId()
  const showHistory = focused && !query.trim() && historyEnabled && queries.length > 0 && runtimeReady && !searching
  const focusQuery = (index: number) => {
    const buttons = formRef.current?.querySelectorAll<HTMLButtonElement>('[data-history-query]')
    if (!buttons?.length) { fieldRef.current?.focus(); return }
    buttons[Math.max(0, Math.min(index, buttons.length - 1))].focus()
  }
  return (
    <form
      ref={formRef}
      className="nw-searchbar is-search-page"
      onSubmit={event => { setFocused(false); onSubmit(event) }}
      onBlur={event => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setFocused(false)
      }}
      onKeyDown={event => {
        if (event.key === 'Escape' && showHistory) {
          event.preventDefault()
          event.stopPropagation()
          fieldRef.current?.focus()
          setFocused(false)
        }
      }}
    >
      <Search width={20} height={20} className="nw-searchbar__icon" />
      <input
        ref={fieldRef}
        value={query}
        onChange={event => { onQueryChange(event.target.value); setFocused(true) }}
        onFocus={() => setFocused(true)}
        onKeyDown={event => {
          if (event.key === 'ArrowDown' && !query.trim() && queries.length && historyEnabled) {
            event.preventDefault()
            setFocused(true)
            window.requestAnimationFrame(() => focusQuery(0))
          }
        }}
        placeholder={runtimeReady ? 'Search titles…' : 'Waiting for NetWatch…'}
        disabled={!runtimeReady || searching}
        spellCheck={false}
        autoComplete="off"
        maxLength={300}
        aria-controls={showHistory ? panelId : undefined}
        aria-label="Search movies, TV and anime"
      />
      <button type="submit" disabled={!runtimeReady || searching || !query.trim()}>
        {searching ? <RefreshCircle width={17} height={17} className="nw-spin" /> : <Search width={17} height={17} />}
        <span>{searching ? 'Searching' : 'Search'}</span>
      </button>
      {showHistory && (
        <section className="nw-search-history" id={panelId} aria-label="Recent searches">
          <header>
            <span>Recent searches</span>
            <button type="button" onClick={() => { localCatalog.clearSearches(); fieldRef.current?.focus() }}>Clear all</button>
          </header>
          <ul>
            {queries.map((entry, index) => (
              <li key={entry}>
                <button
                  type="button"
                  data-history-query
                  className="nw-search-history__query"
                  aria-label={`Search for ${entry}`}
                  onClick={() => { setFocused(false); onSubmit(undefined, entry) }}
                  onKeyDown={event => {
                    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
                      event.preventDefault()
                      if (event.key === 'ArrowUp' && index === 0) fieldRef.current?.focus()
                      else focusQuery(index + (event.key === 'ArrowDown' ? 1 : -1))
                    }
                  }}
                >
                  <Clock width={16} height={16} aria-hidden="true" />
                  <span>{entry}</span>
                </button>
                <button
                  type="button"
                  className="nw-search-history__remove"
                  aria-label={`Remove ${entry} from search history`}
                  title="Remove search"
                  onClick={() => {
                    localCatalog.removeSearch(entry)
                    window.requestAnimationFrame(() => focusQuery(index))
                  }}
                >
                  <Xmark width={17} height={17} />
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}
    </form>
  )
}
