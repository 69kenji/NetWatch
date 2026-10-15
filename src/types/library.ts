export interface LibrarySelection { id: number; type: 'movie' | 'tv'; season?: number; episode?: number }
export interface LibraryItem {
  id: string
  rootId: string
  filename: string
  relativePath: string
  episode: { series: string; season: number; episode: number } | null
  match: (LibrarySelection & { title: string; overview: string; year: string; poster: string | null; backdrop: string | null; episode_title?: string }) | null
}
export interface LibraryState {
  roots: { id: string; name: string; path: string }[]
  items: LibraryItem[]
  warning: string | null
}
