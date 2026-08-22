const { EventEmitter } = require('events')
const { spawn } = require('child_process')
const fs = require('fs')
const net = require('net')
const path = require('path')

const OBSERVED_PROPERTIES = [
  'pause',
  'time-pos',
  'duration',
  'volume',
  'mute',
  'eof-reached',
  'idle-active',
  'media-title',
  'path',
  'aid',
  'sid',
  'sub-delay',
  'track-list',
  'demuxer-cache-duration',
  'cache-buffering-state',
  'paused-for-cache',
  'cache-speed',
  'vo-configured',
  'current-vo',
  'current-gpu-context',
  'window-id',
  'pid',
  'hwdec-current',
]

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, Number(value)))
}

function is2xx(value) {
  return Number.isFinite(value) && value >= 200 && value < 300
}

function startupPlaybackReady(state) {
  return Boolean(
    state
      && !state.idle
      && Number.isFinite(state.duration)
      && state.duration > 0
      // `vo-configured` is not a sufficient startup signal because NetWatch
      // deliberately uses --force-window=immediate. Wait until mpv has loaded
      // an actual video decoder instead; hwdec-current is unavailable before
      // that point and is the string `no` when software decoding is active.
      && typeof state.hwdecCurrent === 'string'
  )
}

function nativeWindowHandleToDecimal(win) {
  const buffer = win.getNativeWindowHandle()

  if (!Buffer.isBuffer(buffer) || buffer.length < 4) {
    throw new Error('Electron did not return a valid native window handle')
  }

  // mpv's Win32 --wid expects HWND cast to uint32_t.
  return buffer.readUInt32LE(0).toString(10)
}
function resolveMpvExecutable() {
  const configured = process.env.NETWATCH_MPV_PATH
  if (configured) {
    // The Windows console entry point is the launch path we have verified with
    // Node/Electron child_process. If an old dev override still points at
    // mpv.exe, transparently prefer the sibling mpv.com when it is present.
    if (process.platform === 'win32' && path.basename(configured).toLowerCase() === 'mpv.exe') {
      const consoleEntry = path.join(path.dirname(configured), 'mpv.com')
      if (fs.existsSync(consoleEntry)) return consoleEntry
    }
    return configured
  }

  const candidates = []
  if (process.platform === 'win32') {
    if (process.resourcesPath) {
      candidates.push(path.join(process.resourcesPath, 'mpv', 'mpv.com'))
      candidates.push(path.join(process.resourcesPath, 'mpv', 'mpv.exe'))
    }
    candidates.push(path.join(__dirname, '..', 'resources', 'mpv', 'mpv.com'))
    candidates.push(path.join(__dirname, '..', 'resources', 'mpv', 'mpv.exe'))
  } else {
    if (process.resourcesPath) candidates.push(path.join(process.resourcesPath, 'mpv', 'mpv'))
    candidates.push(path.join(__dirname, '..', 'resources', 'mpv', 'mpv'))
  }

  const bundled = candidates.find(candidate => fs.existsSync(candidate))
  if (bundled) return bundled

  // Development fallback. Production packaging should bundle mpv under resources/mpv.
  return process.platform === 'win32' ? 'mpv.com' : 'mpv'
}


function quoteWindowsArg(value) {
  const text = String(value)
  if (!text) return '""'
  if (!/[\s"]/u.test(text)) return text

  let result = '"'
  let backslashes = 0

  for (const char of text) {
    if (char === '\\') {
      backslashes += 1
      continue
    }

    if (char === '"') {
      result += '\\'.repeat(backslashes * 2 + 1)
      result += '"'
      backslashes = 0
      continue
    }

    result += '\\'.repeat(backslashes)
    backslashes = 0
    result += char
  }

  result += '\\'.repeat(backslashes * 2)
  result += '"'
  return result
}

const WINDOWS_WMI_LAUNCHER = `
$ErrorActionPreference = 'Stop'

$commandLine = $env:NETWATCH_MPV_COMMAND_LINE
$currentDirectory = $env:NETWATCH_MPV_CWD

if ([string]::IsNullOrWhiteSpace($commandLine)) {
  throw 'NETWATCH_MPV_COMMAND_LINE is missing'
}

# mpv.com is a console-subsystem binary. Without explicit startup information,
# Win32_Process.Create allocates a visible console window even though the small
# PowerShell launcher itself is hidden. Hide only that console; NetWatch's
# embedded --wid video child is shown/resized separately after mpv starts.
$startup = New-CimInstance -ClassName Win32_ProcessStartup -ClientOnly -Property @{
  ShowWindow = [uint16]0
}

$result = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{
  CommandLine = $commandLine
  CurrentDirectory = $currentDirectory
  ProcessStartupInformation = $startup
}

[pscustomobject]@{
  ReturnValue = [int]$result.ReturnValue
  ProcessId = [int]$result.ProcessId
} | ConvertTo-Json -Compress

if ([int]$result.ReturnValue -ne 0) {
  exit 1
}
`.trim()

function encodePowerShellCommand(script) {
  return Buffer.from(script, 'utf16le').toString('base64')
}

async function spawnMpvOnWindows(executable, args) {
  // Electron/Chromium can run inside a Windows Job object. Normal CreateProcess
  // children inherit that job even when Node's `detached` option is used.
  // Win32_Process.Create is deliberately used here because Windows documents
  // that processes created through it are not associated with the caller's job.
  // This keeps mpv on the normal interactive desktop while Electron retains
  // control through mpv's named-pipe JSON IPC.
  const localCwd = process.env.SystemRoot || process.env.USERPROFILE || 'C:\\Windows'
  const commandLine = [executable, ...args].map(quoteWindowsArg).join(' ')
  const encoded = encodePowerShellCommand(WINDOWS_WMI_LAUNCHER)

  const env = {
    ...process.env,
    NETWATCH_MPV_COMMAND_LINE: commandLine,
    NETWATCH_MPV_CWD: localCwd,
  }

  return new Promise((resolve, reject) => {
    const launcher = spawn('powershell.exe', [
      '-NoLogo',
      '-NoProfile',
      '-NonInteractive',
      '-ExecutionPolicy',
      'Bypass',
      '-EncodedCommand',
      encoded,
    ], {
      shell: false,
      windowsHide: true,
      cwd: localCwd,
      stdio: ['ignore', 'pipe', 'pipe'],
      env,
    })

    let stdout = ''
    let stderr = ''
    launcher.stdout.on('data', chunk => { stdout += chunk.toString() })
    launcher.stderr.on('data', chunk => { stderr += chunk.toString() })

    launcher.once('error', reject)
    launcher.once('exit', code => {
      if (code !== 0) {
        reject(new Error(`Win32_Process.Create launcher failed (${code}): ${stderr.trim() || stdout.trim() || 'unknown error'}`))
        return
      }

      try {
        const lines = stdout.trim().split(/\r?\n/u).filter(Boolean)
        const result = JSON.parse(lines.at(-1) || '{}')
        const returnValue = Number(result.ReturnValue)
        const pid = Number(result.ProcessId)

        if (returnValue !== 0 || !Number.isInteger(pid) || pid <= 0) {
          throw new Error(`Win32_Process.Create returned ${returnValue} with PID ${result.ProcessId ?? 'none'}`)
        }

        resolve({ pid, commandLine })
      } catch (error) {
        reject(new Error(`Could not parse Win32_Process.Create result: ${error.message}; stdout=${stdout.trim()}`))
      }
    })
  })
}


const WINDOWS_SURFACE_SYNCER = `
$ErrorActionPreference = 'Stop'

$parentValue = [Int64]$env:NETWATCH_MPV_PARENT_HWND
$targetPid = [UInt32]$env:NETWATCH_MPV_PID
$timeoutMs = [Int32]$env:NETWATCH_MPV_SURFACE_TIMEOUT_MS

Add-Type @"
using System;
using System.Runtime.InteropServices;

public static class NetWatchMpvSurface
{
    public delegate bool EnumWindowsProc(IntPtr hwnd, IntPtr lParam);

    [StructLayout(LayoutKind.Sequential)]
    public struct RECT
    {
        public int Left;
        public int Top;
        public int Right;
        public int Bottom;
    }

    private static uint _targetPid;
    private static IntPtr _found;
    private static int _lastWidth = -1;
    private static int _lastHeight = -1;

    [DllImport("user32.dll")]
    private static extern bool EnumChildWindows(IntPtr hWndParent, EnumWindowsProc lpEnumFunc, IntPtr lParam);

    [DllImport("user32.dll")]
    private static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint processId);

    [DllImport("user32.dll")]
    private static extern bool GetClientRect(IntPtr hWnd, out RECT rect);

    [DllImport("user32.dll")]
    private static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);

    [DllImport("user32.dll")]
    private static extern bool SetWindowPos(IntPtr hWnd, IntPtr hWndInsertAfter, int X, int Y, int cx, int cy, uint uFlags);

    [DllImport("user32.dll")]
    private static extern bool IsWindow(IntPtr hWnd);

    private static bool FindTarget(IntPtr hwnd, IntPtr lParam)
    {
        uint pid;
        GetWindowThreadProcessId(hwnd, out pid);
        if (pid == _targetPid)
        {
            _found = hwnd;
            return false;
        }
        return true;
    }

    public static long FindChild(long parentValue, uint targetPid)
    {
        IntPtr parent = new IntPtr(parentValue);
        _targetPid = targetPid;
        _found = IntPtr.Zero;
        EnumChildWindows(parent, FindTarget, IntPtr.Zero);
        return _found.ToInt64();
    }

    public static bool IsAlive(long hwndValue)
    {
        return hwndValue != 0 && IsWindow(new IntPtr(hwndValue));
    }

    public static int Fit(long parentValue, long childValue)
    {
        IntPtr parent = new IntPtr(parentValue);
        IntPtr child = new IntPtr(childValue);
        if (!IsWindow(parent) || !IsWindow(child))
            return 0;

        RECT client;
        if (!GetClientRect(parent, out client))
            return -1;

        int width = Math.Max(1, client.Right - client.Left);
        int height = Math.Max(1, client.Bottom - client.Top);
        if (width == _lastWidth && height == _lastHeight)
            return 1;

        ShowWindow(child, 5); // SW_SHOW
        bool ok = SetWindowPos(
            child,
            IntPtr.Zero, // HWND_TOP
            0,
            0,
            width,
            height,
            0x0050 // SWP_NOACTIVATE | SWP_SHOWWINDOW
        );
        if (ok)
        {
            _lastWidth = width;
            _lastHeight = height;
        }
        return ok ? 1 : -1;
    }
}
"@

$deadline = [DateTime]::UtcNow.AddMilliseconds([Math]::Max(100, $timeoutMs))
$childValue = 0

do {
    $childValue = [NetWatchMpvSurface]::FindChild($parentValue, $targetPid)
    if ($childValue -gt 0) { break }
    Start-Sleep -Milliseconds 25
} while ([DateTime]::UtcNow -lt $deadline)

if ($childValue -le 0) {
    throw "Timed out waiting for mpv child HWND under parent $parentValue for PID $targetPid"
}

if ([NetWatchMpvSurface]::Fit($parentValue, $childValue) -lt 1) {
    throw 'SetWindowPos/GetClientRect failed while synchronizing the mpv video surface'
}

[pscustomobject]@{
    ChildHwnd = [Int64]$childValue
    ParentHwnd = $parentValue
    ProcessId = $targetPid
} | ConvertTo-Json -Compress
[Console]::Out.Flush()

# Keep one tiny native watcher alive for the lifetime of the player. The old
# implementation launched a complete PowerShell/Add-Type process on every resize
# event; that was the source of the visible resize lag. This loop only calls the
# already-compiled Win32 SetWindowPos when the parent size changes.
while (
    [NetWatchMpvSurface]::IsAlive($parentValue) -and
    [NetWatchMpvSurface]::IsAlive($childValue)
) {
    $fit = [NetWatchMpvSurface]::Fit($parentValue, $childValue)
    if ($fit -lt 0) { exit 2 }
    if ($fit -eq 0) { break }
    Start-Sleep -Milliseconds 16
}
`.trim()

function startMpvSurfaceWatcherOnWindows(parentHwnd, mpvPid, timeoutMs = 1500) {
  if (process.platform !== 'win32') return Promise.resolve(null)
  if (!parentHwnd || !mpvPid) return Promise.resolve(null)

  const localCwd = process.env.SystemRoot || process.env.USERPROFILE || 'C:\\Windows'
  const encoded = encodePowerShellCommand(WINDOWS_SURFACE_SYNCER)
  const env = {
    ...process.env,
    NETWATCH_MPV_PARENT_HWND: String(parentHwnd),
    NETWATCH_MPV_PID: String(mpvPid),
    NETWATCH_MPV_SURFACE_TIMEOUT_MS: String(Math.max(100, Number(timeoutMs) || 1500)),
  }

  return new Promise((resolve, reject) => {
    const helper = spawn('powershell.exe', [
      '-NoLogo',
      '-NoProfile',
      '-NonInteractive',
      '-ExecutionPolicy',
      'Bypass',
      '-EncodedCommand',
      encoded,
    ], {
      shell: false,
      windowsHide: true,
      cwd: localCwd,
      stdio: ['ignore', 'pipe', 'pipe'],
      env,
    })

    let stdout = ''
    let stderr = ''
    let settled = false

    const failBeforeReady = error => {
      if (settled) return
      settled = true
      reject(error)
    }

    helper.stdout.on('data', chunk => {
      stdout += chunk.toString()
      let newline
      while ((newline = stdout.indexOf('\n')) !== -1) {
        const line = stdout.slice(0, newline).trim()
        stdout = stdout.slice(newline + 1)
        if (!line || settled) continue
        try {
          const result = JSON.parse(line)
          const childHwnd = Number(result.ChildHwnd)
          if (Number.isFinite(childHwnd) && childHwnd > 0) {
            settled = true
            resolve({ helper, result })
          }
        } catch (_) {
          // PowerShell can emit harmless host text before the first JSON line.
        }
      }
    })
    helper.stderr.on('data', chunk => { stderr += chunk.toString() })

    helper.once('error', error => failBeforeReady(error))
    helper.once('exit', code => {
      if (!settled) {
        failBeforeReady(new Error(
          `mpv surface watcher failed (${code}): ${stderr.trim() || stdout.trim() || 'unknown error'}`
        ))
      }
    })
  })
}

class MpvController extends EventEmitter {
  constructor() {
    super()
    this.process = null
    this.mpvPid = null
    this.parentHwnd = null
    this.videoChildHwnd = null
    this.surfaceHelper = null
    this.socket = null
    this.pipeName = null
    this.buffer = ''
    this.requestId = 1
    this.pending = new Map()
    this.ready = false
    this.stopping = false
    this.startupHoldActive = false
    this.startupReadyWaiter = null
    this.state = this._defaultState()
  }

  _defaultState() {
    return {
      status: 'idle',
      ready: false,
      paused: true,
      position: 0,
      duration: 0,
      volume: 100,
      muted: false,
      eofReached: false,
      idle: true,
      title: null,
      source: null,
      audioTrack: null,
      subtitleTrack: null,
      subtitleDelay: 0,
      tracks: [],
      cacheDuration: 0,
      cacheBufferingState: 0,
      pausedForCache: false,
      cacheSpeed: 0,
      voConfigured: false,
      currentVo: null,
      currentGpuContext: null,
      windowId: null,
      pid: null,
      hwdecCurrent: null,
      error: null,
    }
  }

  getState() {
    return { ...this.state, tracks: Array.isArray(this.state.tracks) ? [...this.state.tracks] : [] }
  }

  _setState(patch) {
    this.state = { ...this.state, ...patch }
    this.emit('state', this.getState())
    this._resolveStartupReadyWaiterIfReady()
  }

  _resolveStartupReadyWaiterIfReady() {
    if (!this.startupReadyWaiter || !startupPlaybackReady(this.state)) return
    const waiter = this.startupReadyWaiter
    this.startupReadyWaiter = null
    waiter.resolve()
  }

  _waitForStartupVideoReady() {
    if (!this.startupHoldActive || startupPlaybackReady(this.state)) return Promise.resolve()
    if (this.startupReadyWaiter) return this.startupReadyWaiter.promise

    let resolve
    let reject
    const promise = new Promise((onResolve, onReject) => {
      resolve = onResolve
      reject = onReject
    })
    this.startupReadyWaiter = { promise, resolve, reject }
    return promise
  }

  _cancelStartupReadyWaiter(error = new Error('mpv startup stopped')) {
    if (!this.startupReadyWaiter) return
    const waiter = this.startupReadyWaiter
    this.startupReadyWaiter = null
    waiter.reject(error)
  }

  _log(level, message) {
    this.emit('log', { level, message: String(message), timestamp: new Date().toISOString() })
  }

  async start(videoWindow, initialSource = null) {
    if (process.platform !== 'win32') {
      throw new Error('Native mpv HWND embedding is implemented for the Windows desktop target only')
    }
    if (!videoWindow || videoWindow.isDestroyed()) {
      throw new Error('A live Electron video host window is required before starting mpv')
    }
    if (this.mpvPid && this.ready) return this.getState()

    await this.stop({ graceful: false })
    this.stopping = false
    this.startupHoldActive = Boolean(initialSource)
    this._cancelStartupReadyWaiter()
    this.state = this._defaultState()
    this._setState({ status: 'starting' })

    const hwnd = nativeWindowHandleToDecimal(videoWindow)
    this.parentHwnd = hwnd
    this.pipeName = `\\\\.\\pipe\\netwatch-mpv-${process.pid}-${Date.now()}`
    const executable = resolveMpvExecutable()
    const args = [
      '--no-config',
      '--idle=yes',
      '--keep-open=always',
      // Create the Win32 --wid child immediately instead of waiting for the
      // stream to produce a decoded video frame. The surface watcher attaches
      // to this HWND during startup, so delaying its creation can incorrectly
      // turn a healthy but still-buffering source into a fatal timeout.
      '--force-window=immediate',
      '--volume-max=150',
      '--vo=gpu-next',
      '--gpu-api=d3d11',
      '--gpu-context=d3d11',
      // mpv recommends hwdec=auto when hardware decode is desired: it chooses
      // only supported backends and falls back to software if the codec/driver
      // cannot use one. With our D3D11 VO this normally selects D3D11VA.
      '--hwdec=auto',
      // The source is loopback HTTP backed by a live torrent. Give mpv a real
      // packet cache so an underrun pauses instead of repeatedly chasing A/V sync.
      '--cache=yes',
      '--cache-pause=yes',
      '--cache-pause-wait=3',
      '--cache-secs=30',
      '--demuxer-max-bytes=256MiB',
      '--network-timeout=300',
      `--wid=${hwnd}`,
      `--input-ipc-server=${this.pipeName}`,
]

    if (initialSource) {
      // Hold the initial playback clock until mpv has configured a real video
      // output and learned the file duration. Without this, audio can begin
      // while NetWatch is still correctly covering the not-yet-ready video
      // surface with the Starting video/buffering overlay.
      args.push('--pause')
      args.push(initialSource)
}
    this._log('info', `Starting mpv (${executable}) attached to HWND ${hwnd}`)

    try {
      const launched = await spawnMpvOnWindows(executable, args)
      this.mpvPid = launched.pid
      this.process = { pid: launched.pid, killed: false }
      this._log('info', `Win32_Process.Create started mpv PID ${launched.pid}`)
    } catch (error) {
      this._setState({ status: 'error', error: error.message })
      throw error
    }

    await this._connectPipe(10000)

    try {
      const pid = Number(await this.request(['get_property', 'pid']))
      this.mpvPid = Number.isInteger(pid) && pid > 0 ? pid : null
    } catch (error) {
      this._log('warn', `Could not read mpv PID: ${error.message}`)
    }

    await this._observeProperties()

    // mpv creates a Win32 child HWND for --wid, but on this Electron/Windows
    // combination that child can remain hidden/behind the host until it is
    // explicitly shown, raised, and fitted to the parent client area.
    await this.syncVideoSurface(videoWindow, 5000)

    this.ready = true
    this._setState({ status: 'ready', ready: true, error: null })

    if (this.startupHoldActive) {
      await this._waitForStartupVideoReady()
      if (this.stopping || !this.mpvPid) throw new Error('mpv stopped before initial video became ready')

      this._log('info', 'Initial video is ready; releasing startup playback hold')
      await this.request(['set_property', 'pause', false], 5000)
      this.startupHoldActive = false
      // The command succeeded, so make the state transition deterministic even
      // if mpv's corresponding property-change notification arrives one tick later.
      this._setState({ paused: false, status: 'playing' })
    }

    return this.getState()
  }

  async syncVideoSurface(videoWindow = null, timeoutMs = 1500) {
    if (process.platform !== 'win32') return null
    if (!this.mpvPid) return null

    const parentHwnd = videoWindow && !videoWindow.isDestroyed()
      ? nativeWindowHandleToDecimal(videoWindow)
      : this.parentHwnd

    if (!parentHwnd) return null

    // Once the watcher is alive it tracks parent client-size changes at ~60 Hz.
    // Resize events can call this method freely without spawning more helpers.
    if (
      this.surfaceHelper &&
      this.surfaceHelper.exitCode === null &&
      this.videoChildHwnd &&
      String(parentHwnd) === String(this.parentHwnd)
    ) {
      return {
        ChildHwnd: this.videoChildHwnd,
        ParentHwnd: Number(parentHwnd),
        ProcessId: this.mpvPid,
      }
    }

    if (this.surfaceHelper && this.surfaceHelper.exitCode === null) {
      try { this.surfaceHelper.kill() } catch (_) {}
    }
    this.surfaceHelper = null

    const watched = await startMpvSurfaceWatcherOnWindows(parentHwnd, this.mpvPid, timeoutMs)
    const result = watched?.result || null
    const childHwnd = Number(result?.ChildHwnd)
    if (watched?.helper && Number.isFinite(childHwnd) && childHwnd > 0) {
      this.surfaceHelper = watched.helper
      this.parentHwnd = String(parentHwnd)
      this.videoChildHwnd = childHwnd
      this._log('info', `Watching mpv child HWND ${childHwnd} under parent HWND ${parentHwnd}`)

      watched.helper.once('exit', code => {
        if (this.surfaceHelper === watched.helper) {
          this.surfaceHelper = null
          if (!this.stopping && this.mpvPid) {
            this._log('warn', `mpv surface watcher exited (${code ?? 'null'}); it will restart on the next surface sync`)
          }
        }
      })
    }
    return result
  }

  async restartVideoSurface(videoWindow = null, timeoutMs = 2000) {
    if (process.platform !== 'win32') return null

    // A Windows minimize/restore can hide the embedded mpv child without
    // changing the parent client size. The persistent surface watcher normally
    // skips unchanged sizes, so restart it to force one fresh ShowWindow +
    // SetWindowPos pass before resuming its cheap resize watch.
    if (this.surfaceHelper && this.surfaceHelper.exitCode === null) {
      try { this.surfaceHelper.kill() } catch (_) {}
    }
    this.surfaceHelper = null

    return this.syncVideoSurface(videoWindow, timeoutMs)
  }

  async _connectPipe(timeoutMs) {
    const deadline = Date.now() + timeoutMs
    let lastError = null

    while (Date.now() < deadline) {
      if (!this.mpvPid) throw new Error('mpv exited before its IPC pipe became available')
      try {
        await new Promise((resolve, reject) => {
          const socket = net.createConnection(this.pipeName)
          const onError = error => {
            socket.destroy()
            reject(error)
          }
          socket.once('error', onError)
          socket.once('connect', () => {
            socket.removeListener('error', onError)
            this.socket = socket
            this._attachSocket(socket)
            resolve()
          })
        })
        this._log('info', `Connected to mpv IPC pipe ${this.pipeName}`)
        return
      } catch (error) {
        lastError = error
        await new Promise(resolve => setTimeout(resolve, 100))
      }
    }

    throw new Error(`Timed out connecting to mpv IPC pipe: ${lastError?.message || 'unknown error'}`)
  }

  _attachSocket(socket) {
    socket.setEncoding('utf8')
    socket.on('data', chunk => this._consume(chunk))
    socket.on('error', error => {
      if (!this.stopping) this._setState({ status: 'error', ready: false, error: `mpv IPC error: ${error.message}` })
    })
    socket.on('close', () => {
      if (this.socket === socket) this.socket = null
      if (!this.stopping && this.mpvPid) {
        this.ready = false
        this.process = null
        this.mpvPid = null
        this._setState({ status: 'error', ready: false, error: 'mpv IPC pipe closed unexpectedly' })
      }
    })
  }

  _consume(chunk) {
    this.buffer += chunk
    let newline
    while ((newline = this.buffer.indexOf('\n')) !== -1) {
      const line = this.buffer.slice(0, newline).trim()
      this.buffer = this.buffer.slice(newline + 1)
      if (!line) continue
      try {
        this._handleMessage(JSON.parse(line))
      } catch (error) {
        this._log('warn', `Ignoring malformed mpv IPC message: ${error.message}`)
      }
    }
  }

  _handleMessage(message) {
    if (message.request_id != null && this.pending.has(message.request_id)) {
      const pending = this.pending.get(message.request_id)
      this.pending.delete(message.request_id)
      clearTimeout(pending.timer)
      if (message.error && message.error !== 'success') {
        pending.reject(new Error(`mpv command failed: ${message.error}`))
      } else {
        pending.resolve(message.data)
      }
      return
    }

    if (message.event === 'property-change') {
      this._handleProperty(message.name, message.data)
      return
    }

    if (message.event === 'file-loaded') {
      this._setState({ status: this.state.paused ? 'paused' : 'playing', idle: false, eofReached: false })
      return
    }

    if (message.event === 'playback-restart') {
      this._setState({ status: this.state.paused ? 'paused' : 'playing', idle: false })
      return
    }

    if (message.event === 'end-file') {
      this._setState({ status: 'ended', eofReached: true })
      return
    }

    if (message.event === 'shutdown' && !this.stopping) {
      this._setState({ status: 'idle', ready: false })
    }
  }

  _handleProperty(name, value) {
    switch (name) {
      case 'pause':
        this._setState({ paused: Boolean(value), status: this.state.idle ? this.state.status : (value ? 'paused' : 'playing') })
        break
      case 'time-pos':
        if (Number.isFinite(value)) this._setState({ position: value })
        break
      case 'duration':
        if (Number.isFinite(value)) this._setState({ duration: value })
        break
      case 'volume':
        if (Number.isFinite(value)) this._setState({ volume: value })
        break
      case 'mute':
        this._setState({ muted: Boolean(value) })
        break
      case 'eof-reached':
        this._setState({ eofReached: Boolean(value), ...(value ? { status: 'ended' } : {}) })
        break
      case 'idle-active':
        this._setState({ idle: Boolean(value), ...(value ? { status: this.ready ? 'ready' : this.state.status } : {}) })
        break
      case 'media-title':
        this._setState({ title: typeof value === 'string' ? value : null })
        break
      case 'path':
        this._setState({ source: typeof value === 'string' ? value : null })
        break
      case 'aid':
        this._setState({ audioTrack: value ?? null })
        break
      case 'sid':
        this._setState({ subtitleTrack: value ?? null })
        break
      case 'sub-delay':
        if (Number.isFinite(value)) this._setState({ subtitleDelay: value })
        break
      case 'track-list':
        this._setState({ tracks: Array.isArray(value) ? value : [] })
        break
      case 'demuxer-cache-duration':
        if (Number.isFinite(value)) this._setState({ cacheDuration: value })
        break
      case 'cache-buffering-state':
        if (Number.isFinite(value)) this._setState({ cacheBufferingState: value })
        break
      case 'paused-for-cache':
        this._setState({ pausedForCache: Boolean(value) })
        break
      case 'cache-speed':
        if (Number.isFinite(value)) this._setState({ cacheSpeed: value })
        break
      case 'vo-configured':
        this._setState({ voConfigured: Boolean(value) })
        break
      case 'current-vo':
        this._setState({ currentVo: typeof value === 'string' ? value : null })
        break
      case 'current-gpu-context':
        this._setState({ currentGpuContext: typeof value === 'string' ? value : null })
        break
      case 'window-id':
        this._setState({ windowId: value ?? null })
        break
      case 'hwdec-current':
        this._setState({ hwdecCurrent: typeof value === 'string' ? value : null })
        break
      case 'pid':
        if (Number.isInteger(value) && value > 0) {
          this.mpvPid = value
          this._setState({ pid: value })
        }
        break
      default:
        break
    }
  }

  async _observeProperties() {
    let id = 1
    for (const property of OBSERVED_PROPERTIES) {
      await this.request(['observe_property', id++, property])
    }
  }

  request(command, timeoutMs = 5000) {
    if (!this.socket || this.socket.destroyed) {
      return Promise.reject(new Error('mpv IPC is not connected'))
    }
    if (!Array.isArray(command) || !command.length) {
      return Promise.reject(new Error('mpv command must be a non-empty array'))
    }

    const requestId = this.requestId++
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId)
        reject(new Error(`mpv command timed out: ${command[0]}`))
      }, timeoutMs)
      this.pending.set(requestId, { resolve, reject, timer })
      this.socket.write(`${JSON.stringify({ command, request_id: requestId })}\n`, error => {
        if (error) {
          clearTimeout(timer)
          this.pending.delete(requestId)
          reject(error)
        }
      })
    })
  }

  _rejectPending(error) {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer)
      pending.reject(error)
    }
    this.pending.clear()
  }

  async load(source) {
    if (typeof source !== 'string' || !source.trim()) throw new Error('Player source is required')
    if (!this.ready) throw new Error('mpv is not ready')
    this._setState({ status: 'loading', source, position: 0, duration: 0, eofReached: false, error: null })
    await this.request(['loadfile', source, 'replace'])
    return this.getState()
  }

  async execute(action) {
    if (!action || typeof action.type !== 'string') throw new Error('Player action type is required')

    switch (action.type) {
      case 'play':
        return this.request(['set_property', 'pause', false])
      case 'pause':
        return this.request(['set_property', 'pause', true])
      case 'togglePause':
        return this.request(['cycle', 'pause'])
      case 'seekRelative':
        return this.request(['seek', Number(action.seconds) || 0, 'relative+exact'])
      case 'seekAbsolute':
        return this.request(['seek', Math.max(0, Number(action.seconds) || 0), 'absolute+exact'])
      case 'setVolume':
        return this.request(['set_property', 'volume', clamp(action.volume, 0, 150)])
      case 'setMute':
        return this.request(['set_property', 'mute', Boolean(action.muted)])
      case 'loadSubtitle': {
        if (!action.path) throw new Error('Subtitle path is required')
        const command = ['sub-add', action.path, 'select']
        if (action.title || action.language) {
          command.push(action.title || '', action.language || '')
        }
        return this.request(command, 15_000)
      }
      case 'disableSubtitles':
        return this.request(['set_property', 'sid', 'no'])
      case 'setSubtitleDelay':
        return this.request(['set_property', 'sub-delay', Number(action.seconds) || 0])
      case 'setAudioTrack': {
        const target = typeof action.id === 'string' && /^\d+$/.test(action.id)
          ? Number(action.id)
          : action.id

        if (String(this.state.audioTrack) === String(target)) {
          return this.getState()
        }

        // Changing an internal audio stream on a partially downloaded HTTP file can
        // leave mpv's demuxer waiting on packets that were skipped while the previous
        // audio stream was selected. Preserve the current timestamp, select the new
        // track, then perform an exact seek back to that same timestamp so the demuxer
        // opens a fresh ranged read for the newly selected stream. This is equivalent
        // to a track switch plus a zero-distance refresh, without touching NetWatch's
        // torrent scheduling or HTTP piece gate.
        const wasPaused = Boolean(this.state.paused)
        let position = Number(this.state.position)
        if (!Number.isFinite(position) || position < 0) {
          try {
            position = Number(await this.request(['get_property', 'time-pos']))
          } catch (_) {
            position = NaN
          }
        }

        await this.request(['set_property', 'aid', target], 10_000)

        if (Number.isFinite(position) && position >= 0 && !this.state.eofReached) {
          await this.request(['seek', position, 'absolute+exact'], 15_000)
        }

        if (!wasPaused) {
          await this.request(['set_property', 'pause', false], 5_000)
        }

        return this.getState()
      }
      case 'setSubtitleTrack':
        return this.request(['set_property', 'sid', action.id])
      default:
        throw new Error(`Unsupported player action: ${action.type}`)
    }
  }

  async stop({ graceful = true } = {}) {
    this.stopping = true
    this.ready = false
    this.startupHoldActive = false
    this._cancelStartupReadyWaiter(new Error('mpv stopped during startup'))

    const mpvPid = this.mpvPid
    let gracefulQuitSent = false

    if (graceful && this.socket && !this.socket.destroyed) {
      try {
        await Promise.race([
          this.request(['quit']),
          new Promise((_, reject) => setTimeout(() => reject(new Error('quit timeout')), 750)),
        ])
        gracefulQuitSent = true
      } catch (_) {
        // taskkill below is the fallback.
      }
    }

    this.socket?.destroy()
    this.socket = null

    if (this.surfaceHelper && this.surfaceHelper.exitCode === null) {
      try { this.surfaceHelper.kill() } catch (_) {}
    }
    this.surfaceHelper = null
    this._rejectPending(new Error('mpv stopped'))

    if (gracefulQuitSent) {
      await new Promise(resolve => setTimeout(resolve, 500))
    }

    // Win32_Process.Create intentionally launches mpv outside Electron's Job
    // object, so Electron must explicitly own cleanup by PID.
    if (process.platform === 'win32' && mpvPid) {
      try {
        const killer = spawn('taskkill.exe', ['/PID', String(mpvPid), '/T', '/F'], {
          shell: false,
          windowsHide: true,
          stdio: 'ignore',
        })
        killer.unref()
      } catch (_) {}
    }

    this.process = null
    this.mpvPid = null
    this.parentHwnd = null
    this.videoChildHwnd = null
    this.pipeName = null
    this.buffer = ''
    this.stopping = false
    this.state = this._defaultState()
    this.emit('state', this.getState())
  }
}

module.exports = {
  MpvController,
  nativeWindowHandleToDecimal,
  resolveMpvExecutable,
  spawnMpvOnWindows,
  is2xx,
  startupPlaybackReady,
}
