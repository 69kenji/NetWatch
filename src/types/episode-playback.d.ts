interface EpisodePlaybackInfo {
  genres: string[]
  rating: { label: string; country: string } | null
  intro: { start: number; end: number } | null
  outro: { start: number; end: number } | null
  guidance: { label: string; severity: 'mild' | 'moderate' | 'severe' }[]
  guidance_scope: 'series'
  alwaysSkipIntro: boolean
}
