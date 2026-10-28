// Renderer-only storage. Deliberately project fields instead of serializing API responses.
export const MY_LIST_KEY = 'netwatch-my-list-v1'
export const SEARCH_HISTORY_KEY = 'netwatch-search-history-v1'
export const SEARCH_HISTORY_ENABLED_KEY = 'netwatch-search-history-enabled-v1'
export const COLLECTIONS_KEY = 'netwatch-collections-v1'
export const SEARCH_HISTORY_LIMIT = 20
const MY_LIST_LIMIT = 2000
const MAX_STORAGE_LENGTH = 4_000_000

export type SavedTitle = {
  id: number
  type: 'movie' | 'tv'
  title: string
  year: string
  poster: string | null
  backdrop: string | null
  is_anime: boolean
  addedAt: number
}

type StorageAccess = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>
export type Collection = { id: string; name: string; keys: string[] }
type CollectionsData = { items: SavedTitle[]; groups: Collection[]; watched: string[] }
type CatalogState = {
  titles: SavedTitle[]
  queries: string[]
  historyEnabled: boolean
  error: string | null
  collections: CollectionsData
}
const EMPTY_COLLECTIONS: CollectionsData = { items: [], groups: [], watched: [] }

function normalizeCollectionName(value: unknown): string {
  return typeof value === 'string'
    ? value.replace(/[\u0000-\u001f\u007f]/gu, '').replace(/\s+/gu, ' ').trim().slice(0, 80)
    : ''
}

function normalizeCollections(value: unknown): CollectionsData {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return { ...EMPTY_COLLECTIONS }
  const data = value as Partial<CollectionsData>
  const items = normalizeTitles(data.items)
  const keys = new Set(items.map(titleKey))
  const seen = new Set<string>()
  const groups: Collection[] = []
  for (const group of Array.isArray(data.groups) ? data.groups.slice(0, 50) : []) {
    if (!group || typeof group.id !== 'string' || !/^[a-zA-Z0-9_-]{1,64}$/.test(group.id) || seen.has(group.id)) continue
    const name = normalizeCollectionName(group.name)
    if (!name) continue
    seen.add(group.id)
    groups.push({ id: group.id, name, keys: Array.isArray(group.keys) ? [...new Set(group.keys.filter(key => keys.has(key)))].slice(0, MY_LIST_LIMIT) : [] })
  }
  return { items, groups, watched: Array.isArray(data.watched) ? [...new Set(data.watched.filter(key => keys.has(key)))].slice(0, MY_LIST_LIMIT) : [] }
}

export function normalizeSearchQuery(value: unknown): string {
  return typeof value === 'string' ? value.replace(/\s+/gu, ' ').trim().slice(0, 300) : ''
}

function artwork(value: unknown): string | null {
  // Artwork is served only through NetWatch's fixed local image proxy. Never
  // retain arbitrary URLs or direct third-party image hosts in the snapshot.
  if (typeof value !== 'string' || value.length > 512) return null
  try {
    const url = new URL(value)
    const proxyPath = /^\/api\/metadata\/image\/(?:w\d{2,4}|original)\/(?:[A-Za-z0-9._~-]|%[0-9A-Fa-f]{2})+$/u
    return url.origin === 'http://127.0.0.1:8000' && !url.search && !url.hash && proxyPath.test(url.pathname)
      ? value : null
  } catch {
    return null
  }
}

export function savedTitle(value: unknown, addedAt?: number): SavedTitle | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const item = value as Record<string, unknown>
  const date = addedAt ?? item.addedAt
  if (!Number.isSafeInteger(item.id) || Number(item.id) <= 0 || (item.type !== 'movie' && item.type !== 'tv')) return null
  if (typeof item.title !== 'string' || !item.title.trim() || item.title.length > 500) return null
  if (typeof date !== 'number' || !Number.isSafeInteger(date) || date <= 0 || date > 8_640_000_000_000_000) return null
  return {
    id: Number(item.id),
    type: item.type as SavedTitle['type'],
    title: item.title.trim(),
    year: typeof item.year === 'string' && /^\d{4}$/u.test(item.year) ? item.year : '',
    poster: artwork(item.poster),
    backdrop: artwork(item.backdrop),
    is_anime: item.is_anime === true,
    addedAt: date,
  }
}

export function titleKey(item: Pick<SavedTitle, 'id' | 'type'>) {
  return `${item.type}-${item.id}`
}

function normalizeTitles(value: unknown): SavedTitle[] {
  if (!Array.isArray(value)) return []
  const seen = new Set<string>()
  return value.slice(0, MY_LIST_LIMIT).map(item => savedTitle(item))
    .filter((item): item is SavedTitle => item !== null)
    .sort((a, b) => b.addedAt - a.addedAt)
    .filter(item => {
      const key = titleKey(item)
      if (seen.has(key)) return false
      seen.add(key)
      return true
    })
}

function normalizeQueries(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  const seen = new Set<string>()
  const queries: string[] = []
  for (const entry of value) {
    const query = normalizeSearchQuery(entry)
    const key = query.toLowerCase()
    if (!query || seen.has(key)) continue
    seen.add(key)
    queries.push(query)
    if (queries.length === SEARCH_HISTORY_LIMIT) break
  }
  return queries
}

export function createLocalCatalog(storage: StorageAccess | null) {
  let state: CatalogState = { titles: [], queries: [], historyEnabled: true, error: null, collections: { ...EMPTY_COLLECTIONS } }
  let loaded = false
  const listeners = new Set<() => void>()
  const publish = (patch: Partial<CatalogState>) => {
    state = { ...state, ...patch }
    listeners.forEach(listener => listener())
  }
  const write = (key: string, value: unknown): boolean => {
    try {
      if (!storage) throw new Error('Storage unavailable')
      if (value === null) storage.removeItem(key)
      else storage.setItem(key, JSON.stringify(value))
      return true
    } catch {
      publish({ error: 'Could not save local data. Check available disk space and try again.' })
      return false
    }
  }
  const read = (key: string): unknown => {
    const raw = storage?.getItem(key)
    if (!raw) return null
    if (raw.length > MAX_STORAGE_LENGTH) throw new Error('Local data exceeds its size limit')
    return JSON.parse(raw)
  }
  const reload = () => {
    try {
      const historyEnabled = read(SEARCH_HISTORY_ENABLED_KEY) !== false
      const titles = normalizeTitles(read(MY_LIST_KEY))
      const queries = historyEnabled ? normalizeQueries(read(SEARCH_HISTORY_KEY)) : []
      const collections = normalizeCollections(read(COLLECTIONS_KEY))
      loaded = true
      publish({ titles, queries, historyEnabled, collections, error: null })
    } catch {
      // An unreadable store is not an empty store. Never overwrite data after a failed read.
      loaded = false
      publish({ titles: [], queries: [], collections: { ...EMPTY_COLLECTIONS }, historyEnabled: false, error: 'Could not read local data. Restart NetWatch after checking disk access.' })
    }
  }
  reload()
  const saveCollections = (data: CollectionsData) => {
    if (!loaded) return
    const referenced = new Set([...data.watched, ...data.groups.flatMap(group => group.keys)])
    const collections = { ...data, items: data.items.filter(item => referenced.has(titleKey(item))) }
    if (!write(COLLECTIONS_KEY, collections)) return false
    publish({ collections, error: null })
    return true
  }
  const remember = (value: unknown) => {
    const item = savedTitle(value, Date.now())
    if (!item || !loaded) return null
    const existing = state.collections.items.find(entry => titleKey(entry) === titleKey(item))
    if (!existing && state.collections.items.length >= MY_LIST_LIMIT) {
      publish({ error: 'Collections are full. Remove a title before adding another.' })
      return null
    }
    return existing ? state.collections.items : [item, ...state.collections.items]
  }
  return {
    getSnapshot: () => state,
    subscribe: (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener) } },
    reload,
    dismissError: () => publish({ error: null }),
    createCollection: (name: string) => {
      name = normalizeCollectionName(name)
      if (!name || !loaded) return
      if (state.collections.groups.length >= 50) { publish({ error: 'You can create up to 50 collections.' }); return }
      const group = { id: crypto.randomUUID(), name, keys: [] }
      return saveCollections({ ...state.collections, groups: [...state.collections.groups, group] }) ? group.id : null
    },
    renameCollection: (id: string, name: string) => {
      name = normalizeCollectionName(name)
      return name ? saveCollections({ ...state.collections, groups: state.collections.groups.map(group => group.id === id ? { ...group, name } : group) }) : false
    },
    moveCollection: (id: string, direction: -1 | 1) => {
      const groups = [...state.collections.groups]
      const index = groups.findIndex(group => group.id === id)
      const next = index + direction
      if (index < 0 || next < 0 || next >= groups.length) return
      ;[groups[index], groups[next]] = [groups[next], groups[index]]
      saveCollections({ ...state.collections, groups })
    },
    deleteCollection: (id: string) => saveCollections({ ...state.collections, groups: state.collections.groups.filter(group => group.id !== id) }),
    setCollectionTitle: (id: string, value: unknown, included: boolean) => {
      if (!state.collections.groups.some(group => group.id === id)) return false
      const items = remember(value)
      const item = savedTitle(value, Date.now())
      if (!items || !item) return
      const key = titleKey(item)
      const groups = state.collections.groups.map(group => group.id !== id ? group : { ...group,
        keys: included ? [...new Set([key, ...group.keys])] : group.keys.filter(entry => entry !== key),
      })
      return saveCollections({ ...state.collections, items, groups })
    },
    toggleWatched: (value: unknown) => {
      const items = remember(value)
      const item = savedTitle(value, Date.now())
      if (!items || !item) return
      const key = titleKey(item)
      const watched = state.collections.watched.includes(key) ? state.collections.watched.filter(entry => entry !== key) : [...state.collections.watched, key]
      saveCollections({ ...state.collections, items, watched })
    },
    setWatched: (value: unknown, included: boolean) => {
      const items = remember(value)
      const item = savedTitle(value, Date.now())
      if (!items || !item) return false
      const key = titleKey(item), exists = state.collections.watched.includes(key)
      if (exists === included) return true
      const watched = included ? [...state.collections.watched, key] : state.collections.watched.filter(entry => entry !== key)
      return saveCollections({ ...state.collections, items, watched })
    },
    toggleTitle: (value: unknown) => {
      if (!loaded) { publish({ error: 'My List could not be read. Restart NetWatch after checking disk access.' }); return }
      const item = savedTitle(value, Date.now())
      if (!item) { publish({ error: 'This title could not be added to My List.' }); return }
      const existing = state.titles.some(entry => titleKey(entry) === titleKey(item))
      if (!existing && state.titles.length >= MY_LIST_LIMIT) {
        publish({ error: 'My List is full. Remove a title before adding another.' })
        return
      }
      const remaining = state.titles.filter(entry => titleKey(entry) !== titleKey(item))
      const titles = existing ? remaining : [item, ...remaining]
      if (write(MY_LIST_KEY, titles.length ? titles : null)) publish({ titles, error: null })
    },
    removeTitle: (item: Pick<SavedTitle, 'id' | 'type'>) => {
      if (!loaded) { publish({ error: 'My List could not be read. Restart NetWatch after checking disk access.' }); return }
      const titles = state.titles.filter(entry => titleKey(entry) !== titleKey(item))
      if (write(MY_LIST_KEY, titles.length ? titles : null)) publish({ titles, error: null })
    },
    recordSearch: (value: string) => {
      if (!state.historyEnabled) return
      const query = normalizeSearchQuery(value)
      if (!query) return
      const queries = normalizeQueries([query, ...state.queries])
      if (write(SEARCH_HISTORY_KEY, queries)) publish({ queries, error: null })
    },
    removeSearch: (query: string) => {
      const queries = state.queries.filter(entry => entry !== query)
      if (write(SEARCH_HISTORY_KEY, queries.length ? queries : null)) publish({ queries, error: null })
    },
    clearSearches: () => {
      if (write(SEARCH_HISTORY_KEY, null)) publish({ queries: [], error: null })
    },
    setHistoryEnabled: (historyEnabled: boolean) => {
      if (!historyEnabled) {
        // Forget in memory even if storage is inaccessible; report failed disk erasure.
        const erased = write(SEARCH_HISTORY_KEY, null)
        const saved = write(SEARCH_HISTORY_ENABLED_KEY, false)
        publish({
          historyEnabled: false,
          queries: [],
          error: erased && saved ? null : 'Search history could not be turned off. Check disk access and try again.',
        })
      } else if (write(SEARCH_HISTORY_ENABLED_KEY, true)) {
        publish({ historyEnabled: true, error: null })
      }
    },
  }
}
