import { useEffect, useRef, useState } from 'react'
import { Check, EditPencil, Plus, Trash, User, Xmark } from 'iconoir-react'
import { useProfiles } from '../store/profiles'

export function ProfileControls({ compact = false }: { compact?: boolean }) {
  const state = useProfiles()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [name, setName] = useState('')
  const [open, setOpen] = useState(false)
  const [editing, setEditing] = useState<'new' | 'rename' | null>(null)
  const compactRoot = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!compact || !open) return
    const closeOutside = (event: PointerEvent) => {
      if (!compactRoot.current?.contains(event.target as Node)) setOpen(false)
    }
    document.addEventListener('pointerdown', closeOutside)
    return () => document.removeEventListener('pointerdown', closeOutside)
  }, [compact, open])
  if (!state) return null
  const run = async (action: () => Promise<unknown>) => {
    setBusy(true); setError(null)
    try { await action(); setName(''); setEditing(null) } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)) }
    finally { setBusy(false) }
  }
  const active = state.profiles.find(profile => profile.id === state.activeId)
  const selector = <select className="nw-settings-select" aria-label="Active profile" value={state.activeId} disabled={busy}
    onChange={event => {
      const id = event.target.value
      void run(() => window.electron!.profiles.switch(id))
    }}>
    {state.profiles.map(profile => <option key={profile.id} value={profile.id}>{profile.name}</option>)}
  </select>
  if (compact) return <div ref={compactRoot} className="nw-profile-switcher" onBlur={event => { if (!event.currentTarget.contains(event.relatedTarget)) setOpen(false) }} onKeyDown={event => { if (event.key === 'Escape') { event.stopPropagation(); setOpen(false) } }}>
    <button type="button" className="nw-nav-button" aria-label={`Profile: ${active?.name || ''}`} data-tooltip={open ? undefined : `Profiles: ${active?.name || ''}`} aria-expanded={open} onClick={() => setOpen(!open)}><User width={20} height={20} /></button>
    {open && <div className="nw-profile-switcher__panel">{selector}{error && <p role="alert">{error}</p>}</div>}
  </div>
  return <section className="nw-settings-card nw-settings-card--compact nw-profile-settings">
    <div className="nw-profile-row">
      <div className="nw-settings-card__copy"><strong>Current profile</strong></div>
      {selector}
      <div className="nw-compact-actions">
        <button type="button" className="nw-icon-button" disabled={busy} title="New profile" aria-label="New profile" onClick={() => { setEditing('new'); setName('') }}><Plus width={18} height={18} /></button>
        <button type="button" className="nw-icon-button" disabled={busy} title="Rename profile" aria-label="Rename profile" onClick={() => { setEditing('rename'); setName(active?.name || '') }}><EditPencil width={17} height={17} /></button>
        <button type="button" className="nw-icon-button" disabled={busy || state.profiles.length < 2} title="Delete profile" aria-label="Delete profile" onClick={() => void run(() => window.electron!.profiles.delete(state.activeId))}><Trash width={17} height={17} /></button>
      </div>
    </div>
    {editing && <form className="nw-inline-editor" onSubmit={event => {
      event.preventDefault()
      if (busy || !name.trim()) return
      void run(() => editing === 'new' ? window.electron!.profiles.create(name) : window.electron!.profiles.rename(state.activeId, name))
    }}>
      <input autoFocus className="nw-settings-select" aria-label={editing === 'new' ? 'New profile name' : 'Profile name'} placeholder={editing === 'new' ? 'New profile name' : 'Profile name'} value={name} maxLength={40} disabled={busy} onChange={event => setName(event.target.value)} />
      <button type="submit" className="nw-icon-button" disabled={busy || !name.trim()} title="Save profile" aria-label="Save profile"><Check width={18} height={18} /></button>
      <button type="button" className="nw-icon-button" disabled={busy} title="Cancel" aria-label="Cancel" onClick={() => setEditing(null)}><Xmark width={18} height={18} /></button>
    </form>}
    <p className="nw-profile-note">Paired phones use the active profile. Volume is shared.</p>
    {error && <p role="alert">{error}</p>}
  </section>
}
