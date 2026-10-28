export const THEME_IDS = ['signature', 'cinema', 'blue-hour', 'dusk', 'warm-slate', 'daylight', 'liquid-glass', 'frosted-glass', 'minimal-acrylic']
export const DEFAULT_ACCENT = '#7B61FF'
export const DEFAULT_BACKGROUND = Object.freeze({ imageId: null, fit: 'cover', position: 'center', dimPercent: 40 })
export const DEFAULT_MATERIAL_BLUR = 16
export const DEFAULT_APPEARANCE = Object.freeze({ theme: 'signature', accentColor: DEFAULT_ACCENT, customAccentColor: DEFAULT_ACCENT, density: 'comfortable', materialBlur: DEFAULT_MATERIAL_BLUR, background: DEFAULT_BACKGROUND })
export const IMAGE_ID = /^[a-f0-9]{32}$/u
export const validHex = value => typeof value === 'string' && /^#[0-9a-f]{6}$/iu.test(value)
export function normalizeAppearance(value) {
  const v = value && typeof value === 'object' && !Array.isArray(value) ? value : {}
  const b = v.background && typeof v.background === 'object' ? v.background : {}
  const migratedTheme = v.theme === 'transparent' ? 'minimal-acrylic' : v.theme
  const materialBlur = typeof v.materialBlur === 'number' && Number.isFinite(v.materialBlur) && v.materialBlur >= 8 && v.materialBlur <= 28
    ? Math.round(v.materialBlur)
    : DEFAULT_MATERIAL_BLUR
  return {
    theme: THEME_IDS.includes(migratedTheme) ? migratedTheme : 'signature',
    accentColor: validHex(v.accentColor) ? v.accentColor.toUpperCase() : DEFAULT_ACCENT,
    customAccentColor: validHex(v.customAccentColor) ? v.customAccentColor.toUpperCase() : DEFAULT_ACCENT,
    density: v.density === 'compact' ? 'compact' : 'comfortable',
    materialBlur,
    background: {
      imageId: typeof b.imageId === 'string' && IMAGE_ID.test(b.imageId) ? b.imageId : null,
      fit: b.fit === 'contain' ? 'contain' : 'cover',
      position: ['center', 'top', 'bottom', 'left', 'right'].includes(b.position) ? b.position : 'center',
      dimPercent: typeof b.dimPercent === 'number' && Number.isFinite(b.dimPercent) ? Math.round(Math.max(0, Math.min(70, b.dimPercent))) : 40,
    },
  }
}

// Opaque palette values also define the material themes' fallback and text backplates.
export const THEMES = [
  ['signature', 'NetWatch Signature', '#07070D', '#0B0B13', '#171725', '#F3F1FB', '#B5B0C4', '#2D2B3A', 12, 580, 'Default dark theme.'],
  ['cinema', 'Cinema Black', '#000000', '#080808', '#1D1D1D', '#F5F5F5', '#B8B8B8', '#333333', 8, 520, 'Black with sharp corners.'],
  ['blue-hour', 'Blue Hour', '#070D1B', '#0D1526', '#1B2941', '#F1F5FF', '#B7C5DC', '#35445C', 10, 620, 'Dark blue.'],
  ['dusk', 'Dusk Plum', '#120D18', '#1B1422', '#30243B', '#F7EFFA', '#CEBED3', '#493A52', 16, 560, 'Dark plum.'],
  ['warm-slate', 'Warm Slate', '#12100F', '#1A1715', '#302923', '#F5F0E8', '#CEC1B3', '#483E36', 10, 520, 'Warm charcoal.'],
  ['daylight', 'Daylight', '#F4F5F8', '#FFFFFF', '#E9ECF2', '#171921', '#52586A', '#D7DDE6', 12, 600, 'Light theme.'],
  ['liquid-glass', 'Liquid Glass', '#111522', '#1E2436', '#384258', '#F8FAFF', '#D5DDEB', '#738099', 16, 560, 'Clear translucent panels.'],
  ['frosted-glass', 'Frosted Glass', '#111820', '#1B2530', '#2C3744', '#F6F9FC', '#D2DCE4', '#626E7A', 14, 580, 'Blurred translucent panels.'],
  ['minimal-acrylic', 'Minimal Acrylic', '#12141A', '#10141C', '#181E2A', '#FFFFFF', '#DEE3EE', '#616875', 10, 520, 'Simple tinted panels.'],
].map(([id, name, canvas, surface, raised, text, secondary, border, radius, weight, description]) =>
  ({ id, name, canvas, surface, raised, text, secondary, border, radius, weight, description }))

export function rgb(hex) { return [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16)) }
export function hexColor(channels) { return '#' + channels.map(v => Math.round(Math.max(0, Math.min(255, v))).toString(16).padStart(2, '0')).join('').toUpperCase() }
export function mix(a, b, ratio) { return hexColor(rgb(a).map((v, i) => v * (1 - ratio) + rgb(b)[i] * ratio)) }
export function contrast(a, b) {
  const luminance = hex => rgb(hex).map(v => { const x = v / 255; return x <= .04045 ? x / 12.92 : ((x + .055) / 1.055) ** 2.4 }).reduce((sum, v, i) => sum + v * [.2126, .7152, .0722][i], 0)
  const x = luminance(a), y = luminance(b)
  return (Math.max(x, y) + .05) / (Math.min(x, y) + .05)
}
export function accessibleTone(raw, backgrounds, minimum = 4.5) {
  if (backgrounds.every(bg => contrast(raw, bg) >= minimum)) return raw
  const target = backgrounds.reduce((a, bg) => a + contrast('#FFFFFF', bg), 0) > backgrounds.reduce((a, bg) => a + contrast('#000000', bg), 0) ? '#FFFFFF' : '#000000'
  for (let step = 1; step <= 100; step++) {
    const candidate = mix(raw, target, step / 100)
    if (backgrounds.every(bg => contrast(candidate, bg) >= minimum)) return candidate
  }
  return target
}
export function resolveAppearance(value, player = false) {
  const settings = normalizeAppearance(value)
  const selected = THEMES.find(theme => theme.id === settings.theme)
  const palette = player && selected.id === 'daylight' ? THEMES[0] : selected
  const { canvas, surface, raised, text, secondary, border, radius, weight } = palette
  const raw = settings.accentColor
  const accent = accessibleTone(raw, [canvas, surface, raised], 3)
  const onAccent = contrast('#000000', accent) >= contrast('#FFFFFF', accent) ? '#000000' : '#FFFFFF'
  const light = !player && selected.id === 'daylight'
  const subtle = mix(surface, accent, light ? .09 : .12)
  const hover = mix(raised, text, .06)
  const backgrounds = [canvas, surface, raised, hover, subtle]
  const accentText = accessibleTone(raw, backgrounds)
  const material = ['liquid-glass', 'frosted-glass', 'minimal-acrylic'].includes(selected.id)
  const materialRanges = { 'liquid-glass': [.54, .66], 'frosted-glass': [.74, .86], 'minimal-acrylic': [.58, .76] }
  const materialRange = material ? materialRanges[selected.id] : null
  const blurProgress = (settings.materialBlur - 8) / 20
  const materialAlpha = materialRange ? materialRange[1] - (materialRange[1] - materialRange[0]) * blurProgress : 1
  const alpha = value => Math.max(.01, Math.min(.97, value)).toFixed(3)
  const materialProfile = material ? {
    'liquid-glass': { canvas: materialAlpha - .24, chrome: materialAlpha - .10, raised: materialAlpha + .07, popover: materialAlpha + .14, blurScale: .9, raisedBlur: 4, edge: 'inset 0 1px rgba(255,255,255,.16)' },
    'frosted-glass': { canvas: materialAlpha - .18, chrome: materialAlpha - .08, raised: materialAlpha + .05, popover: materialAlpha + .08, blurScale: 1.1, raisedBlur: 5, edge: 'none' },
    'minimal-acrylic': { canvas: materialAlpha - .26, chrome: materialAlpha - .12, raised: materialAlpha + .07, popover: materialAlpha + .13, blurScale: .8, raisedBlur: 3, edge: 'none' },
  }[selected.id] : null
  const materialBlur = materialProfile ? Math.max(8, Math.min(28, Math.round(settings.materialBlur * materialProfile.blurScale))) : 0
  const materialBlurRaised = materialProfile ? Math.max(8, Math.min(28, materialBlur + materialProfile.raisedBlur)) : 0
  const rgba = (color, opacity) => `rgba(${rgb(color).join(',')},${alpha(opacity)})`
  const surfaceCanvas = material ? rgba(canvas, materialProfile.canvas) : canvas
  const surfaceInteractive = material ? rgba(surface, materialAlpha) : surface
  const surfacePopover = material ? rgba(raised, materialProfile.popover) : raised
  const interactiveHover = material ? rgba(raised, materialProfile.raised) : hover
  return { settings, palette, tokens: {
    '--nw-bg-canvas': canvas, '--nw-bg-surface': surface, '--nw-bg-raised': raised, '--nw-bg-popover': raised,
    '--nw-bg-hover': hover, '--nw-bg-selected': subtle,
    '--nw-text-primary': accessibleTone(text, backgrounds), '--nw-text-secondary': accessibleTone(secondary, backgrounds),
    '--nw-border': border, '--nw-border-strong': accessibleTone(border, [surface, raised], 3),
    '--nw-accent-raw': raw, '--nw-accent-interactive': accent, '--nw-accent-text': accentText,
    '--nw-accent-on-interactive': onAccent, '--nw-accent-subtle': subtle,
    '--nw-accent-on-media': accessibleTone(raw, ['#08080C', '#62626E'], 3),
    '--nw-focus-ring': accessibleTone(raw, [canvas, surface, raised, subtle], 3),
    '--nw-success': accessibleTone('#52D990', backgrounds), '--nw-warning': accessibleTone('#EEB65F', backgrounds),
    '--nw-danger': accessibleTone('#EF6C78', backgrounds), '--nw-radius-card': `${radius}px`, '--nw-heading-weight': String(weight),
    '--nw-radius-control': `${Math.max(5, radius - 5)}px`, '--nw-shadow': selected.id === 'cinema' ? 'none' : `0 4px 16px rgba(0,0,0,${light ? '.10' : '.24'})`,
    '--nw-card-border': 'transparent',
    '--nw-surface-canvas': surfaceCanvas, '--nw-surface-interactive': surfaceInteractive,
    '--nw-surface-popover': surfacePopover, '--nw-interactive-hover': interactiveHover,
    '--nw-material-canvas': surfaceCanvas,
    '--nw-material-chrome': material ? rgba(surface, materialProfile.chrome) : surface,
    '--nw-material-surface': surfaceInteractive,
    '--nw-material-raised': interactiveHover,
    '--nw-material-popover': surfacePopover,
    '--nw-material': material ? rgba(surface, materialProfile.chrome) : surface,
    '--nw-material-blur': `${materialBlur}px`, '--nw-material-blur-raised': `${materialBlurRaised}px`,
    '--nw-material-edge': materialProfile?.edge || 'none',
    '--nw-canvas-scrim': light ? 'rgba(244,245,248,.15)' : 'rgba(0,0,0,.15)',
    '--nw-color-scheme': light ? 'light' : 'dark',
  } }
}
