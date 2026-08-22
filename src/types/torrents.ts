export type TorrentSearchResult = {
  title: string
  magnet?: string
  source_url?: string
  source_type?: string
  info_hash?: string | null
  size?: number
  seeders?: number
  leechers?: number
  indexer?: string
  published?: string
  resolution?: string
  codec?: string
  source?: string
  audio?: string
}

export type NetWatchView = 'home' | 'discover' | 'search' | 'movie' | 'series' | 'settings'
export type ResultSort = 'quality' | 'seeders' | 'size'
export type QualityFilter = 'all' | '2160p' | '1080p' | '720p'

const RESOLUTION_WEIGHT: Record<string, number> = {
  '2160p': 4,
  '4K': 4,
  '1080p': 3,
  '720p': 2,
  '480p': 1,
}

export function resultSource(result: TorrentSearchResult) {
  return result.source_url || result.magnet || ''
}

export function formatBytes(bytes = 0) {
  if (!Number.isFinite(bytes) || bytes <= 0) return 'Unknown size'
  const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB']
  let value = bytes
  let index = 0
  while (value >= 1024 && index < units.length - 1) {
    value /= 1024
    index += 1
  }
  const digits = index >= 3 ? 2 : index >= 2 ? 1 : 0
  return `${value.toFixed(digits)} ${units[index]}`
}




function resolutionWeight(result: TorrentSearchResult) {
  const resolution = result.resolution || ''
  return RESOLUTION_WEIGHT[resolution] || 0
}

export function sortResults(results: TorrentSearchResult[], mode: ResultSort) {
  return [...results].sort((a, b) => {
    if (mode === 'seeders') return (b.seeders || 0) - (a.seeders || 0)
    if (mode === 'size') return (a.size || Number.MAX_SAFE_INTEGER) - (b.size || Number.MAX_SAFE_INTEGER)

    const qualityDelta = resolutionWeight(b) - resolutionWeight(a)
    if (qualityDelta !== 0) return qualityDelta
    return (b.seeders || 0) - (a.seeders || 0)
  })
}
