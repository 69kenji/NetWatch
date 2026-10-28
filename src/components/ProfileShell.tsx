import { useEffect, useState } from 'react'
import App from '../App'
import { localCatalog } from '../store/localCatalog'
import { publishProfiles, type ProfileState } from '../store/profiles'
import { pruneProfileStorage, selectProfileStorage } from '../utils/profileStorage'

export function ProfileShell() {
  const [profileId, setProfileId] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    let active = true
    let previous: ProfileState | null = null
    const apply = (state: ProfileState) => {
      if (!active) return
      try {
        selectProfileStorage(state.activeId, state.initialId)
        pruneProfileStorage(state.profiles.map(profile => profile.id))
        if (previous?.activeId !== state.activeId) localCatalog.reload()
        previous = state
        publishProfiles(state)
        setProfileId(state.activeId)
        setError(null)
      } catch (reason) { setError(reason instanceof Error ? reason.message : 'Could not load profile') }
    }
    const api = window.electron?.profiles
    if (!api) { setError('The profile service is unavailable. Restart NetWatch.'); return }
    let changed = false
    const unsubscribe = api.onChanged(state => { changed = true; apply(state) })
    void api.getState().then(state => { if (!changed) apply(state) }).catch(reason => { if (active && !changed) setError(String(reason)) })
    return () => { active = false; unsubscribe() }
  }, [])
  if (error) return <div className="nw-profile-error" role="alert"><p>{error}</p><button className="btn btn-secondary" onClick={() => window.location.reload()}>Retry</button></div>
  return profileId ? <App key={profileId} /> : null
}
