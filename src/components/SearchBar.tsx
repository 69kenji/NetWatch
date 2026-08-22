import type { FormEvent, RefObject } from 'react'
import { RefreshCircle, Search } from 'iconoir-react'

type SearchBarProps = {
  query: string
  runtimeReady: boolean
  searching: boolean
  inputRef?: RefObject<HTMLInputElement>
  onQueryChange: (value: string) => void
  onSubmit: (event?: FormEvent) => void
}

export function SearchBar({ query, runtimeReady, searching, inputRef, onQueryChange, onSubmit }: SearchBarProps) {
  return (
    <form className="nw-searchbar is-search-page" onSubmit={onSubmit}>
      <Search width={20} height={20} className="nw-searchbar__icon" />
      <input
        ref={inputRef}
        value={query}
        onChange={event => onQueryChange(event.target.value)}
        placeholder={runtimeReady ? 'Search titles…' : 'Waiting for NetWatch…'}
        disabled={!runtimeReady || searching}
        spellCheck={false}
        aria-label="Search movies, TV and anime"
      />
      <button type="submit" disabled={!runtimeReady || searching || !query.trim()}>
        {searching ? <RefreshCircle width={17} height={17} className="nw-spin" /> : <Search width={17} height={17} />}
        <span>{searching ? 'Searching' : 'Search'}</span>
      </button>
    </form>
  )
}
