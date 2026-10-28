import { useEffect, useRef, useState, type CSSProperties } from 'react'
import { Check, Palette, RefreshCircle, Trash } from 'iconoir-react'
import { DEFAULT_ACCENT, DEFAULT_BACKGROUND, THEMES, contrast, resolveAppearance } from '../../../shared/appearance.mjs'
import { previewMaterialBlur, updateAppearance, useAppearance, useBackgroundImage } from '../../theme/appearance'
import type { AppearancePreferences } from '../../theme/types'
import { AccentColorPicker } from './AccentColorPicker'

const ACCENTS = [['NetWatch Violet', '#7B61FF'], ['Azure', '#3B82F6'], ['Jade', '#10B981'], ['Coral', '#F97373'], ['Amber', '#F59E0B'], ['Orchid', '#C26BFA']]
export function AppearanceSettings() {
  const { preferences, previewAccent } = useAppearance(), image = useBackgroundImage()
  const [trigger, setTrigger] = useState<HTMLElement | null>(null), [busy, setBusy] = useState(false), [error, setError] = useState<string | null>(null)
  const [dimming, setDimming] = useState(preferences.background.dimPercent)
  const [materialBlur, setMaterialBlur] = useState(preferences.materialBlur)
  const committedBlur = useRef(preferences.materialBlur)
  useEffect(() => { setDimming(preferences.background.dimPercent) }, [preferences.background])
  useEffect(() => { setMaterialBlur(preferences.materialBlur); committedBlur.current = preferences.materialBlur }, [preferences.materialBlur])
  const run = async (action: () => Promise<unknown>) => { setBusy(true); setError(null); try { await action() } catch (reason) { setError(reason instanceof Error ? reason.message.replace(/^Error invoking remote method '[^']+': (?:Error: )?/, '') : 'Could not save appearance.') } finally { setBusy(false) } }
  const update = (patch: Parameters<typeof updateAppearance>[0]) => void run(() => updateAppearance(patch))
  const material = ['liquid-glass', 'frosted-glass', 'minimal-acrylic'].includes(preferences.theme)
  const blurLabel = materialBlur <= 12 ? 'Soft' : materialBlur >= 22 ? 'Strong' : 'Balanced'
  const commitMaterialBlur = (value: number) => {
    if (value === committedBlur.current) return
    committedBlur.current = value
    update({ materialBlur: value })
  }
  return <section className="nw-appearance" aria-labelledby="appearance-title">
    <h2 id="appearance-title">Appearance</h2>
    <h3>Theme</h3>
    <div className="nw-theme-grid" role="group" aria-label="Theme">
      {THEMES.map(theme => {
        const resolved = resolveAppearance({ ...preferences, accentColor: previewAccent || preferences.accentColor, theme: theme.id }), selected = theme.id === preferences.theme
        const isMaterial = ['liquid-glass', 'frosted-glass', 'minimal-acrylic'].includes(theme.id)
        return <button type="button" key={theme.id} className={`nw-theme-preview${selected ? ' is-selected' : ''}`} aria-pressed={selected} disabled={busy} title={theme.description} onClick={() => update({ theme: theme.id as AppearancePreferences['theme'] })}>
          <span className={`nw-theme-mini${isMaterial ? ' is-material' : ''}`} style={{ '--preview-canvas': theme.canvas, '--preview-surface': resolved.tokens['--nw-material'], '--preview-raised': theme.raised, '--preview-text': theme.text, '--preview-accent': resolved.tokens['--nw-accent-interactive'], '--preview-radius': `${theme.radius}px` } as CSSProperties} aria-hidden="true">
            <i className="nw-theme-mini__sidebar" /><i className="nw-theme-mini__panel"><b /><b /><em /></i>
          </span><span>{theme.name}{selected && <Check width={17} height={17} />}</span>
        </button>
      })}
    </div>
    <h3>Accent color</h3>
    <div className="nw-appearance-row"><button type="button" className="btn btn-secondary nw-accent-current" onClick={event => setTrigger(event.currentTarget)}><i style={{ background: preferences.accentColor }} />{preferences.accentColor}</button></div>
    <div className="nw-accent-presets" role="group" aria-label="Accent presets">{ACCENTS.map(([name, color]) => <button type="button" key={name} aria-label={name} title={`${name} ${color}`} aria-pressed={preferences.accentColor === color} disabled={busy} onClick={() => update({ accentColor: color })}>
      <i style={{ background: color, color: contrast(color, '#000000') >= contrast(color, '#FFFFFF') ? '#000000' : '#FFFFFF' }}>{preferences.accentColor === color && <Check width={18} height={18} />}</i><span>{name === 'NetWatch Violet' ? 'Violet' : name}</span>
    </button>)}</div>
    <div className="nw-appearance-row"><button className="btn btn-ghost" onClick={event => setTrigger(event.currentTarget)}><Palette width={18} height={18} />Custom…</button><button className="btn btn-ghost" disabled={busy} onClick={() => update({ accentColor: DEFAULT_ACCENT })}>Reset to violet</button></div>
    <h3>Density</h3>
    <div className="nw-appearance-row" role="group" aria-label="Interface density">{(['comfortable', 'compact'] as const).map(density => <label key={density}><input type="radio" name="density" checked={preferences.density === density} disabled={busy} onChange={() => update({ density })} />{density === 'compact' ? 'Compact' : 'Comfortable'}</label>)}</div>
    {material && <>
      <h3>Blur</h3>
      <div className="nw-material-blur">
        <input type="range" min={8} max={28} step={1} value={materialBlur} disabled={busy} aria-label="Interface blur" aria-valuetext={`${blurLabel}, ${materialBlur} pixels`}
          onChange={event => { const value = Number(event.target.value); setMaterialBlur(value); previewMaterialBlur(value) }}
          onPointerUp={event => commitMaterialBlur(Number(event.currentTarget.value))}
          onKeyUp={event => { if (['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End', 'PageUp', 'PageDown'].includes(event.key)) commitMaterialBlur(Number(event.currentTarget.value)) }}
          onBlur={event => commitMaterialBlur(Number(event.currentTarget.value))} />
        <div className="nw-material-blur__labels" aria-hidden="true"><span>Soft</span><span>Balanced</span><span>Strong</span></div>
        <output aria-live="off">{materialBlur}px</output>
      </div>
    </>}
    <h3>Background</h3>
    <div className="nw-appearance-row"><button className="btn btn-secondary" disabled={busy} onClick={() => void run(() => window.electron!.appearance.importImage())}>{busy ? <RefreshCircle width={18} className="nw-spin" /> : null}Choose image…</button>
      <button className="btn btn-ghost" disabled={busy || !preferences.background.imageId} onClick={() => update({ background: { imageId: null } })}><Trash width={17} height={17} />Remove</button></div>
    {image.data && <img className="nw-background-preview" src={image.data} alt="Selected background" />}
    {!preferences.background.imageId && <p>No image</p>}
    {preferences.background.imageId && <>
      <div className="nw-appearance-row"><label>Fit<select value={preferences.background.fit} disabled={busy} onChange={event => update({ background: { fit: event.target.value as 'cover' | 'contain' } })}><option value="cover">Cover</option><option value="contain">Contain</option></select></label>
        <label>Position<select value={preferences.background.position} disabled={busy} onChange={event => update({ background: { position: event.target.value as AppearancePreferences['background']['position'] } })}>{['center', 'top', 'bottom', 'left', 'right'].map(position => <option key={position} value={position}>{position[0].toUpperCase() + position.slice(1)}</option>)}</select></label></div>
      <label className="nw-appearance-row">Dim<input type="range" aria-label="Background dimming" min={0} max={70} value={dimming} disabled={busy}
        onChange={event => { const value = Number(event.target.value); setDimming(value); document.documentElement.style.setProperty('--nw-image-dim', String(value / 100)) }}
        onPointerUp={event => update({ background: { dimPercent: Number(event.currentTarget.value) } })}
        onKeyUp={event => { if (['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End', 'PageUp', 'PageDown'].includes(event.key)) update({ background: { dimPercent: Number(event.currentTarget.value) } }) }}
        onBlur={event => { if (!busy && Number(event.currentTarget.value) !== preferences.background.dimPercent) update({ background: { dimPercent: Number(event.currentTarget.value) } }) }} /><output>{dimming}%</output></label>
      <button className="btn btn-ghost" disabled={busy} onClick={() => update({ background: { ...DEFAULT_BACKGROUND, imageId: preferences.background.imageId } })}>Reset background</button>
    </>}
    {(error || image.error) && <p className="nw-appearance-error" role="alert">{error || image.error}</p>}
    {trigger && <AccentColorPicker trigger={trigger} onClose={() => setTrigger(null)} />}
  </section>
}
