export type ThemeId = 'signature' | 'cinema' | 'blue-hour' | 'dusk' | 'warm-slate' | 'daylight' | 'liquid-glass' | 'frosted-glass' | 'minimal-acrylic'
export type AppearancePreferences = {
  theme: ThemeId
  accentColor: string
  customAccentColor: string
  density: 'comfortable' | 'compact'
  materialBlur: number
  background: { imageId: string | null; fit: 'cover' | 'contain'; position: 'center' | 'top' | 'bottom' | 'left' | 'right'; dimPercent: number }
}
export type AppearanceState = { preferences: AppearancePreferences; previewAccent: string | null; reducedEffects: boolean; native?: { mode: 'opaque' | 'acrylic'; supported: boolean } }
