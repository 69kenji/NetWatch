import { create } from 'zustand'

export interface MediaItem {
  id: number
  type: 'movie' | 'tv'
  title: string
  year: string
  overview: string
  poster: string | null
  backdrop: string | null
  backdrop_original?: string | null
  logo?: string | null
  rating: number
  imdb_id?: string
  tmdb_id?: number
  season?: number
  episode?: number
  episode_title?: string
}

export interface Subtitle {
  id: string
  language: string
  name: string
  download_ref: string
  source: 'opensubtitles' | 'subdl' | string
  format: string
  rating?: number
  downloads?: number
  hearing_impaired?: boolean
  trusted?: boolean
  fps?: number | string | null
  file_name?: string | null
}

interface PlayerState {
  isOpen: boolean
  infoHash: string | null
  mediaItem: MediaItem | null
  filePath: string | null
  subtitlePath: string | null
  subtitleToken: string | null
  subtitleId: string | null
  subtitleName: string | null
  subtitleSource: string | null
  volume: number
  position: number
  duration: number
  paused: boolean
  subtitleDelay: number
  audioTrack: number
}

interface AppStore {
  player: PlayerState
  setPlayerMedia: (hash: string, media: MediaItem, path: string) => void
  updatePlayer: (patch: Partial<PlayerState>) => void
  closePlayer: () => void
}

const DEFAULT_PLAYER: PlayerState = {
  isOpen: false, infoHash: null, mediaItem: null,
  filePath: null, subtitlePath: null,
  subtitleToken: null, subtitleId: null, subtitleName: null, subtitleSource: null,
  volume: 100, position: 0, duration: 0,
  paused: false, subtitleDelay: 0, audioTrack: 1,
}

export const useAppStore = create<AppStore>((set) => ({
  player: DEFAULT_PLAYER,
  setPlayerMedia: (infoHash, mediaItem, filePath) =>
    set((state) => ({ player: { ...state.player, isOpen: true, infoHash, mediaItem, filePath } })),
  updatePlayer: (patch) => set((state) => ({ player: { ...state.player, ...patch } })),
  closePlayer: () => set({ player: DEFAULT_PLAYER }),
}))
