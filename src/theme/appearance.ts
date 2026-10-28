import { useSyncExternalStore } from 'react'
import { DEFAULT_APPEARANCE, normalizeAppearance, resolveAppearance } from '../../shared/appearance.mjs'
import type { AppearancePreferences, AppearanceState } from './types'

let state: AppearanceState = { preferences: normalizeAppearance(DEFAULT_APPEARANCE) as AppearancePreferences, previewAccent: null, reducedEffects: false }
let image: { data: string | null; error: string | null } = { data: null, error: null }
let imageId: string | null = null, imageRequest = 0, isPlayer = false
const listeners = new Set<() => void>()
const notify = () => listeners.forEach(listener => listener())
export function useAppearance() { return useSyncExternalStore(listener => { listeners.add(listener); return () => { listeners.delete(listener) } }, () => state) }
export function useBackgroundImage() { return useSyncExternalStore(listener => { listeners.add(listener); return () => { listeners.delete(listener) } }, () => image) }
export function applyAppearance() {
  const preferences = { ...state.preferences, accentColor: state.previewAccent || state.preferences.accentColor }
  const { settings, tokens } = resolveAppearance(preferences, isPlayer)
  const root = document.documentElement
  root.dataset.nwTheme = settings.theme
  root.dataset.nwDensity = settings.density
  root.dataset.nwPlayer = String(isPlayer)
  root.dataset.nwDesktop = isPlayer ? 'opaque' : state.native?.mode || 'opaque'
  const reduced = state.reducedEffects || matchMedia('(prefers-reduced-transparency: reduce)').matches || matchMedia('(forced-colors: active)').matches
  root.dataset.nwReducedEffects = String(reduced)
  Object.entries(tokens).forEach(([key, value]) => root.style.setProperty(key, String(value)))
  if (reduced) {
    const opaque = {
      '--nw-surface-canvas': tokens['--nw-bg-canvas'],
      '--nw-surface-interactive': tokens['--nw-bg-surface'],
      '--nw-surface-popover': tokens['--nw-bg-popover'],
      '--nw-interactive-hover': tokens['--nw-bg-raised'],
      '--nw-material-canvas': tokens['--nw-bg-canvas'],
      '--nw-material-chrome': tokens['--nw-bg-surface'],
      '--nw-material-surface': tokens['--nw-bg-surface'],
      '--nw-material-raised': tokens['--nw-bg-raised'],
      '--nw-material-popover': tokens['--nw-bg-popover'],
    }
    Object.entries(opaque).forEach(([key, value]) => root.style.setProperty(key, String(value)))
  }
  root.style.colorScheme = tokens['--nw-color-scheme']
  root.style.setProperty('--nw-image-fit', settings.background.fit)
  root.style.setProperty('--nw-image-position', settings.background.position)
  root.style.setProperty('--nw-image-dim', String(settings.background.dimPercent / 100))
}
function accept(next: AppearanceState) {
  state = { ...next, preferences: normalizeAppearance(next.preferences) as AppearancePreferences }
  applyAppearance()
  const id = state.preferences.background.imageId
  if (!isPlayer && id !== imageId) {
    imageId = id
    const request = ++imageRequest
    image = { data: null, error: null }
    document.documentElement.style.removeProperty('--nw-background-image')
    document.documentElement.dataset.nwImage = 'false'
    if (id) void window.electron?.appearance.image().then(async result => {
      if (request !== imageRequest || result.imageId !== imageId) return
      const valid = result.data && /^data:image\/png;base64,[A-Za-z0-9+/=]+$/u.test(result.data)
      if (valid) {
        const decoded = new Image()
        decoded.src = result.data!
        await decoded.decode()
        if (request !== imageRequest) return
        document.documentElement.style.setProperty('--nw-background-image', `url("${result.data}")`)
        document.documentElement.dataset.nwImage = 'true'
      }
      image = { data: valid ? result.data : null, error: result.error }
      notify()
    }).catch(() => { if (request === imageRequest) { image = { data: null, error: 'Background could not be loaded.' }; notify() } })
  }
  notify()
}
export function bootstrapAppearance(player = false) {
  isPlayer = player
  const api = window.electron?.appearance
  api?.onChanged(accept)
  const initial = api?.initial()
  if (initial) accept(initial)
  else applyAppearance()
  for (const query of ['(prefers-reduced-motion: reduce)', '(prefers-reduced-transparency: reduce)', '(forced-colors: active)']) matchMedia(query).addEventListener('change', applyAppearance)
}
export function previewAccent(color: string | null) {
  state = { ...state, previewAccent: color }
  applyAppearance(); notify()
}
export function previewMaterialBlur(materialBlur: number) {
  const { tokens } = resolveAppearance({ ...state.preferences, materialBlur }, isPlayer)
  for (const [key, value] of Object.entries(tokens)) {
    if (key.startsWith('--nw-material') || key.startsWith('--nw-surface') || key === '--nw-interactive-hover') {
      document.documentElement.style.setProperty(key, value)
    }
  }
}
export async function updateAppearance(patch: Parameters<NonNullable<Window['electron']>['appearance']['update']>[0]) {
  const api = window.electron?.appearance
  if (!api) throw new Error('Appearance settings require the desktop app.')
  accept(await api.update(patch))
}
