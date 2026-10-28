export const PROFILE_STORAGE_KEYS = ['netwatch-my-list-v1', 'netwatch-search-history-v1', 'netwatch-search-history-enabled-v1', 'netwatch-ui-preferences-v1', 'netwatch-collections-v1', 'netwatch-tracked-series-v1'] as const
const KEYS = [...PROFILE_STORAGE_KEYS]
const PROFILE_VALUE_LIMIT = 4_000_000
let activeId: string | null = null

function prefix(id: string) {
  if (!/^[a-zA-Z0-9_-]{1,64}$/.test(id)) throw new Error('Invalid profile')
  return `netwatch-profile-${id}:`
}

export function selectProfileStorage(id: string, initialId: string) {
  const base = prefix(id)
  const storage = window.localStorage
  if (id === initialId && storage.getItem(`${base}migrated`) !== '1') {
    // Copy all legacy values before removing any. A quota/read failure leaves
    // the originals intact, and retrying this migration is safe.
    const legacy = KEYS.map(key => [key, storage.getItem(key)] as const)
    for (const [key, value] of legacy) {
      if (value !== null && storage.getItem(base + key) === null) {
        if (value.length > 4_000_000) throw new Error('Existing profile data is too large to migrate')
        JSON.parse(value)
        storage.setItem(base + key, value)
      }
    }
    storage.setItem(`${base}migrated`, '1')
    for (const [key] of legacy) storage.removeItem(key)
  }
  activeId = id
}

export function removeProfileStorage(id: string) {
  const base = prefix(id)
  for (const key of [...KEYS, 'migrated']) window.localStorage.removeItem(base + key)
}

export function pruneProfileStorage(ids: string[]) {
  const live = new Set(ids)
  const storage = window.localStorage
  const obsolete = new Set<string>()
  for (let index = 0; index < storage.length; index++) {
    const match = /^netwatch-profile-([a-zA-Z0-9_-]{1,64}):/.exec(storage.key(index) || '')
    if (match && !live.has(match[1])) obsolete.add(match[1])
  }
  for (const id of obsolete) removeProfileStorage(id)
}

export type ProfileStorageBackup = Record<string, Partial<Record<(typeof PROFILE_STORAGE_KEYS)[number], string>>>

export function exportProfileStorage(ids: string[]): ProfileStorageBackup {
  const result: ProfileStorageBackup = {}
  for (const id of ids) {
    const base = prefix(id)
    const values: ProfileStorageBackup[string] = {}
    for (const key of PROFILE_STORAGE_KEYS) {
      const raw = window.localStorage.getItem(base + key)
      if (raw === null) continue
      if (raw.length > PROFILE_VALUE_LIMIT) throw new Error('Profile data is too large to export')
      JSON.parse(raw)
      values[key] = raw
    }
    result[id] = values
  }
  return result
}

export function stageProfileStorageRestore(
  imported: ProfileStorageBackup,
  selection: { library: boolean; history: boolean },
) {
  const selectedKeys = new Set<(typeof PROFILE_STORAGE_KEYS)[number]>(['netwatch-ui-preferences-v1'])
  if (selection.library) {
    selectedKeys.add('netwatch-my-list-v1')
    selectedKeys.add('netwatch-collections-v1')
  }
  if (selection.history) {
    selectedKeys.add('netwatch-search-history-v1')
    selectedKeys.add('netwatch-search-history-enabled-v1')
    selectedKeys.add('netwatch-tracked-series-v1')
  }
  const previous = new Map<string, string | null>()
  const touched: string[] = []
  try {
    for (const [id, values] of Object.entries(imported)) {
      const base = prefix(id)
      if (!values || typeof values !== 'object' || Array.isArray(values)) throw new Error('Backup profile data is invalid')
      for (const key of selectedKeys) {
        const fullKey = base + key
        previous.set(fullKey, window.localStorage.getItem(fullKey))
        touched.push(fullKey)
        const raw = values[key]
        if (raw === undefined) window.localStorage.removeItem(fullKey)
        else {
          if (typeof raw !== 'string' || raw.length > PROFILE_VALUE_LIMIT) throw new Error('Backup profile data is invalid')
          JSON.parse(raw)
          window.localStorage.setItem(fullKey, raw)
        }
      }
      const migrated = `${base}migrated`
      previous.set(migrated, window.localStorage.getItem(migrated))
      touched.push(migrated)
      window.localStorage.setItem(migrated, '1')
    }
  } catch (error) {
    for (const key of touched.reverse()) {
      const raw = previous.get(key)
      if (raw === null || raw === undefined) window.localStorage.removeItem(key)
      else window.localStorage.setItem(key, raw)
    }
    throw error
  }
  let finished = false
  return {
    commit() { finished = true },
    rollback() {
      if (finished) return
      for (const key of touched.reverse()) {
        const raw = previous.get(key)
        if (raw === null || raw === undefined) window.localStorage.removeItem(key)
        else window.localStorage.setItem(key, raw)
      }
      finished = true
    },
  }
}

export const profileStorage: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'> = {
  getItem(key) { return activeId ? window.localStorage.getItem(prefix(activeId) + key) : null },
  setItem(key, value) {
    if (!activeId) throw new Error('Profile is not ready')
    window.localStorage.setItem(prefix(activeId) + key, value)
  },
  removeItem(key) {
    if (!activeId) throw new Error('Profile is not ready')
    window.localStorage.removeItem(prefix(activeId) + key)
  },
}
