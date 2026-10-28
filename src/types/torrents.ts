import { resolutionWeight as qualityWeight, selectAutomaticRelease } from '../../shared/quality-policy.mjs'

export type TorrentSearchResult = {
  title: string
  release_ref: string
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

export type NetWatchView = 'home' | 'discover' | 'search' | 'movie' | 'series' | 'settings' | 'library' | 'collections' | 'history' | 'queue' | 'profile'
export type ResultSort = 'quality' | 'seeders' | 'size'
export type QualityFilter = 'all' | '2160p' | '1080p' | '720p'

export function resultSource(result: TorrentSearchResult) {
  return result.release_ref || ''
}

export function assertReleaseReferences(results: TorrentSearchResult[] | undefined) {
  if (!Array.isArray(results) || results.length === 0) return
  if (results.some(result => !result || typeof result.release_ref !== 'string' || !result.release_ref.trim())) {
    throw new Error(
      'NetWatch runtime is out of date. Restart NetWatch so the bundled backend can be refreshed, then try again.',
    )
  }
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
  return qualityWeight(result.resolution)
}

export function selectAutomaticResult(results: TorrentSearchResult[], ceiling: QualityFilter) {
  return selectAutomaticRelease(results, ceiling)
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
