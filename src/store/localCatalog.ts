import { useSyncExternalStore } from 'react'
import { createLocalCatalog } from '../utils/localCatalog'
import { profileStorage } from '../utils/profileStorage'

export const localCatalog = createLocalCatalog(profileStorage)

export function useLocalCatalog() {
  return useSyncExternalStore(localCatalog.subscribe, localCatalog.getSnapshot)
}
