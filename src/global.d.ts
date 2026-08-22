interface NativePlayerTrack {
  id?: number | string
  type?: string
  title?: string
  lang?: string
  selected?: boolean
  default?: boolean
  external?: boolean
  codec?: string
  [key: string]: unknown
}

interface NativePlayerState {
  status: 'idle' | 'starting' | 'ready' | 'loading' | 'playing' | 'paused' | 'ended' | 'error'
  ready: boolean
  paused: boolean
  position: number
  duration: number
  volume: number
  muted: boolean
  eofReached: boolean
  idle: boolean
  title: string | null
  source: string | null
  audioTrack: number | string | null
  subtitleTrack: number | string | null
  subtitleDelay: number
  tracks: NativePlayerTrack[]
  cacheDuration: number
  cacheBufferingState: number
  pausedForCache: boolean
  cacheSpeed: number
  voConfigured: boolean
  hwdecCurrent?: string | null
  error: string | null
}

type NativePlayerPreparationStage =
  | 'idle'
  | 'adding'
  | 'metadata'
  | 'peers'
  | 'buffering'
  | 'starting'
  | 'ready'
  | 'error'

interface NativePlayerPreparationState {
  stage: NativePlayerPreparationStage
  ready: boolean
  message: string | null
  infoHash: string | null
  progress: number | null
  videoProgress: number | null
  downloaded: number
  size: number
  dlSpeed: number
  seeders: number
  peers: number
  torrentState: string | null
  firstReady: boolean
  lastReady: boolean
  bufferedBytes: number
  bufferTargetBytes: number
  bufferProgress: number
  error: string | null
  updatedAt: string
}

interface NativePlayerSession {
  source: string | null
  title: string | null
  infoHash: string | null
  filePath: string | null
  mediaItem: import('./store').MediaItem | null
  openedAt: string
}

type NativePlayerAction =
  | { type: 'play' }
  | { type: 'pause' }
  | { type: 'togglePause' }
  | { type: 'seekRelative'; seconds: number }
  | { type: 'seekAbsolute'; seconds: number }
  | { type: 'setVolume'; volume: number }
  | { type: 'setMute'; muted: boolean }
  | { type: 'loadSubtitle'; path: string; token?: string | null; title?: string | null; language?: string | null }
  | { type: 'disableSubtitles' }
  | { type: 'setSubtitleDelay'; seconds: number }
  | { type: 'setAudioTrack'; id: number | string }
  | { type: 'setSubtitleTrack'; id: number | string }

interface NetWatchRuntimeStatus {
  phase: 'starting' | 'docker' | 'services' | 'ready' | 'error' | string
  ready: boolean
  message: string
  error: string | null
  services: {
    docker: string
    stack: string
    backend: string
    torrentEngine: string
    prowlarr: string
  }
}


interface NetWatchVpnProfile {
  profile_type: 'generic' | 'vpnbook'
  imported_at?: string | null
  source_created_at?: string | null
  source_modified_at?: string | null
  estimated_created_at?: string | null
  estimated_expires_at?: string | null
  expiry_basis?: 'file_creation_time' | 'file_modification_time' | 'import_time' | string | null
  replacement_pending?: boolean
}

interface NetWatchVpnSanityResult {
  status: 'ok' | 'unsafe' | 'error' | string
  connected: boolean
  vpn_interface: string
  vpn_interface_present: boolean
  public_ip: string | null
  checked_at?: string
  source?: string
  dns_ok?: boolean
  dns_host?: string
  dns_addresses?: string[]
  dns_error?: string | null
  error?: string | null
  structural_verified: boolean
}

interface Window {
  electron?: {
    window: {
      minimize: () => void
      maximize: () => void
      close: () => void
    }
    runtime: {
      getStatus: () => Promise<NetWatchRuntimeStatus>
      retry: () => Promise<NetWatchRuntimeStatus>
      vpnSanity: () => Promise<NetWatchVpnSanityResult>
      getVpnProfile: () => Promise<NetWatchVpnProfile>
      setVpnProfileType: (profileType: 'generic' | 'vpnbook') => Promise<NetWatchVpnProfile>
      replaceWireGuard: (profileType: 'generic' | 'vpnbook') => Promise<{
        cancelled: boolean
        profile: NetWatchVpnProfile
        restart_required: boolean
      }>
      openVpnBook: () => Promise<{ opened: boolean }>
      restartApp: () => Promise<{ restarting: boolean }>
      onStatus: (callback: (status: NetWatchRuntimeStatus) => void) => () => void
    }
    player: {
      openTorrent: (request: {
        torrentSource: string
        title?: string | null
        mediaName?: string | null
        expectedHash?: string | null
        mediaItem?: import('./store').MediaItem | null
      }) => Promise<{
        session: NativePlayerSession
        state: NativePlayerState
        preparation: NativePlayerPreparationState
      }>
      getSession: () => Promise<NativePlayerSession | null>
      getState: () => Promise<NativePlayerState>
      getPreparation: () => Promise<NativePlayerPreparationState>
      command: (action: NativePlayerAction) => Promise<unknown>
      close: () => Promise<void>
      setFullscreen: (enabled: boolean) => Promise<boolean>
      toggleFullscreen: () => Promise<boolean>
      getWindowState: () => Promise<{ fullscreen: boolean; maximized: boolean }>
      onState: (callback: (state: NativePlayerState) => void) => () => void
      onPreparation: (callback: (state: NativePlayerPreparationState) => void) => () => void
      onSession: (callback: (session: NativePlayerSession | null) => void) => () => void
      onWindowState: (callback: (state: { fullscreen: boolean; maximized: boolean }) => void) => () => void
      onLog: (callback: (entry: { level: string; message: string; timestamp: string }) => void) => () => void
    }
  }
}
