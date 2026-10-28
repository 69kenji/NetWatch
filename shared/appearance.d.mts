import type { AppearancePreferences, ThemeId } from '../src/theme/types'
export const DEFAULT_ACCENT: string
export const DEFAULT_MATERIAL_BLUR: number
export const DEFAULT_APPEARANCE: AppearancePreferences
export const DEFAULT_BACKGROUND: AppearancePreferences['background']
export const THEME_IDS: ThemeId[]
export const IMAGE_ID: RegExp
export function validHex(value: unknown): boolean
export function normalizeAppearance(value: unknown): AppearancePreferences
export type Theme = { id: ThemeId; name: string; canvas: string; surface: string; raised: string; text: string; secondary: string; border: string; radius: number; weight: number; description: string }
export const THEMES: Theme[]
export function rgb(hex: string): number[]
export function hexColor(channels: number[]): string
export function mix(a: string, b: string, ratio: number): string
export function contrast(a: string, b: string): number
export function accessibleTone(raw: string, backgrounds: string[], minimum?: number): string
export function resolveAppearance(value: unknown, player?: boolean): { settings: AppearancePreferences; palette: Theme; tokens: Record<string, string> }
