import { useSyncExternalStore } from 'react'

export type ProfileState = NetWatchProfileState
let state: ProfileState | null = null
const listeners = new Set<() => void>()
export function publishProfiles(next: ProfileState) {
  state = next
  listeners.forEach(listener => listener())
}
export function useProfiles() {
  return useSyncExternalStore(listener => { listeners.add(listener); return () => { listeners.delete(listener) } }, () => state)
}
