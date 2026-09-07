'use strict'

const { BaseWindow, BrowserWindow } = require('electron')
const path = require('path')
const { playerFullscreenShortcutAction } = require('./player-shortcuts')

function createPlayerWindowManager({
  getMainWindow,
  hardenRendererNavigation,
  isDev,
  mpv,
  onNativeCloseRequested,
  onOverlayClosed,
  onWindowStateChanged,
  playerRendererUrl,
  shouldAllowNativeClose,
}) {
  if (
    typeof getMainWindow !== 'function' ||
    typeof hardenRendererNavigation !== 'function' ||
    !mpv ||
    typeof onNativeCloseRequested !== 'function' ||
    typeof onOverlayClosed !== 'function' ||
    typeof onWindowStateChanged !== 'function' ||
    typeof playerRendererUrl !== 'function' ||
    typeof shouldAllowNativeClose !== 'function'
  ) {
    throw new Error('Player window manager dependencies are invalid')
  }

  let videoWindow
  let overlayWindow
  let surfaceSyncTimer = null
  let launchWindowState = { maximized: false, fullscreen: false }

  function syncBounds() {
    if (!videoWindow || videoWindow.isDestroyed()) return
    if (!overlayWindow || overlayWindow.isDestroyed()) return

    // With the native Windows frame restored, controls belong only to the client
    // area. getContentBounds() excludes the title bar and resize border.
    overlayWindow.setBounds(videoWindow.getContentBounds())
  }

  function scheduleVideoSurfaceSync(delayMs = 75) {
    if (surfaceSyncTimer) clearTimeout(surfaceSyncTimer)
    surfaceSyncTimer = setTimeout(() => {
      surfaceSyncTimer = null
      if (!videoWindow || videoWindow.isDestroyed()) return
      void mpv.syncVideoSurface(videoWindow, 1500).catch(error => {
        console.error('[Player surface]', error)
      })
    }, delayMs)
  }

  function restoreFullscreenForeground(delayMs = 0) {
    setTimeout(() => {
      if (!videoWindow || videoWindow.isDestroyed()) return
      if (!videoWindow.isFullScreen()) return

      // Returning to a fullscreen BaseWindow through Alt+Tab or its taskbar entry can
      // leave the transparent BrowserWindow controls behind the mpv host while the
      // Windows taskbar remains foreground. Reassert the player pair's z-order and
      // give focus back to the interactive overlay without changing fullscreen state.
      try { videoWindow.moveTop() } catch (_) {}
      syncBounds()

      if (overlayWindow && !overlayWindow.isDestroyed()) {
        overlayWindow.show()
        try { overlayWindow.moveTop() } catch (_) {}
        overlayWindow.focus()
      } else {
        videoWindow.focus()
      }

      scheduleVideoSurfaceSync(50)
    }, Math.max(0, delayMs))
  }

  function restoreVisualsAfterMinimize() {
    // Windows can restore the BaseWindow at exactly the same client size it had
    // before minimization. mpv's persistent child-HWND watcher intentionally skips
    // unchanged sizes, so a child hidden by minimization would otherwise stay
    // hidden and expose only the host's black background. Restarting the watcher
    // forces one ShowWindow/SetWindowPos pass, then returns to the cheap resize loop.
    setTimeout(() => {
      if (!videoWindow || videoWindow.isDestroyed()) return

      syncBounds()
      void mpv.restartVideoSurface(videoWindow, 2500)
        .then(() => {
          if (!overlayWindow || overlayWindow.isDestroyed()) return
          syncBounds()
          overlayWindow.show()
          overlayWindow.focus()
        })
        .catch(error => {
          console.error('[Player restore surface]', error)
        })
    }, 75)
  }

  function getLaunchPlacement() {
    const mainWindow = getMainWindow()
    if (!mainWindow || mainWindow.isDestroyed()) {
      return {
        bounds: { x: 100, y: 100, width: 1280, height: 720 },
        maximized: false,
        fullscreen: false,
      }
    }

    // Preserve the main window's normal/restored geometry separately from its
    // current state. A maximized Electron window's getBounds() describes the
    // maximized rectangle; using that as the player's normal bounds would make
    // "restore" reopen as a screen-sized window. getNormalBounds() retains the
    // actual restored size while we explicitly carry maximized/fullscreen state.
    return {
      bounds: mainWindow.getNormalBounds(),
      maximized: mainWindow.isMaximized(),
      fullscreen: mainWindow.isFullScreen(),
    }
  }

  function showVideoFromLaunchState() {
    if (!videoWindow || videoWindow.isDestroyed()) return

    if (launchWindowState.fullscreen) {
      videoWindow.show()
      videoWindow.setFullScreen(true)
    } else if (launchWindowState.maximized) {
      // maximize() also shows a hidden native window on Windows. This preserves
      // the real maximized state rather than merely sizing a normal window to the
      // monitor rectangle, so mpv and its overlay inherit the correct client area.
      videoWindow.maximize()
    } else {
      videoWindow.show()
    }
  }

  async function create() {
    if (
      videoWindow && !videoWindow.isDestroyed() &&
      overlayWindow && !overlayWindow.isDestroyed()
    ) {
      return
    }

    const launchPlacement = getLaunchPlacement()
    const bounds = launchPlacement.bounds
    launchWindowState = {
      maximized: launchPlacement.maximized,
      fullscreen: launchPlacement.fullscreen,
    }

    videoWindow = new BaseWindow({
      ...bounds,
      minWidth: 800,
      minHeight: 450,
      frame: true,
      show: false,
      title: 'NetWatch Player',
      backgroundColor: '#000000',
      minimizable: true,
      maximizable: true,
      resizable: true,
    })
    videoWindow.setMenuBarVisibility(false)

    const contentBounds = videoWindow.getContentBounds()
    overlayWindow = new BrowserWindow({
      ...contentBounds,
      frame: false,
      show: false,
      transparent: true,
      backgroundColor: '#00000000',
      hasShadow: false,
      parent: videoWindow,
      resizable: false,
      movable: false,
      minimizable: false,
      maximizable: false,
      closable: false,
      skipTaskbar: true,
      webPreferences: {
        preload: path.join(__dirname, 'player-preload.js'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        webSecurity: true,
        webviewTag: false,
        devTools: isDev && process.env.NETWATCH_DEVTOOLS === '1',
      },
    })
    overlayWindow.setMenuBarVisibility(false)
    overlayWindow.webContents.on('before-input-event', (event, input) => {
      const action = playerFullscreenShortcutAction(input)
      if (action === 'ignore') return

      // Chromium/Electron otherwise applies F11 to the focused transparent overlay
      // BrowserWindow. The visible player is the native BaseWindow hosting mpv, so
      // consume the browser shortcut and route it through the existing player
      // fullscreen controller instead. This keeps the overlay and mpv surface in sync.
      event.preventDefault()
      if (action === 'toggle') void toggleFullscreen()
    })
    const expectedOverlayUrl = playerRendererUrl()
    hardenRendererNavigation(overlayWindow.webContents, expectedOverlayUrl)
    await overlayWindow.loadURL(expectedOverlayUrl)

    const sync = () => {
      syncBounds()
      scheduleVideoSurfaceSync(50)
    }

    videoWindow.on('move', sync)
    videoWindow.on('resize', sync)
    videoWindow.on('resized', () => scheduleVideoSurfaceSync(0))
    videoWindow.on('enter-full-screen', sync)
    videoWindow.on('leave-full-screen', sync)
    videoWindow.on('maximize', sync)
    videoWindow.on('unmaximize', sync)
    videoWindow.on('restore', restoreVisualsAfterMinimize)
    videoWindow.on('focus', () => restoreFullscreenForeground(0))

    // The native title-bar X delegates the configured close behavior to the session
    // controller. Keep the window alive while playback state and temporary data are
    // cleaned up. The in-player back button remains a separate return-to-menu action.
    videoWindow.on('close', event => {
      if (shouldAllowNativeClose()) return
      event.preventDefault()
      void onNativeCloseRequested()
    })

    videoWindow.on('closed', () => {
      videoWindow = null
    })

    overlayWindow.on('closed', () => {
      overlayWindow = null
      onOverlayClosed()
    })

    syncBounds()
  }

  function setTitle(title) {
    if (!videoWindow || videoWindow.isDestroyed()) return
    videoWindow.setTitle(title ? `${title} — NetWatch` : 'NetWatch Player')
  }

  function showShell({ focus = true } = {}) {
    const mainWindow = getMainWindow()
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.hide()
    showVideoFromLaunchState()
    syncBounds()
    if (overlayWindow && !overlayWindow.isDestroyed()) {
      overlayWindow.show()
      if (focus) overlayWindow.focus()
    }
  }

  function showOverlay({ focus = true } = {}) {
    if (!overlayWindow || overlayWindow.isDestroyed()) return
    syncBounds()
    overlayWindow.show()
    if (focus) overlayWindow.focus()
  }

  function hide() {
    if (surfaceSyncTimer) {
      clearTimeout(surfaceSyncTimer)
      surfaceSyncTimer = null
    }
    if (overlayWindow && !overlayWindow.isDestroyed()) overlayWindow.hide()
    if (videoWindow && !videoWindow.isDestroyed()) videoWindow.hide()
  }

  function destroy() {
    if (surfaceSyncTimer) {
      clearTimeout(surfaceSyncTimer)
      surfaceSyncTimer = null
    }

    const overlay = overlayWindow
    const video = videoWindow
    overlayWindow = null
    videoWindow = null

    if (overlay && !overlay.isDestroyed()) overlay.destroy()
    if (video && !video.isDestroyed()) video.destroy()
  }

  async function setFullscreen(enabled) {
    if (!videoWindow || videoWindow.isDestroyed()) return false
    videoWindow.setFullScreen(Boolean(enabled))
    setTimeout(syncBounds, 50)
    scheduleVideoSurfaceSync(100)
    const fullscreen = videoWindow.isFullScreen()
    if (fullscreen) restoreFullscreenForeground(50)
    onWindowStateChanged({
      fullscreen,
      maximized: videoWindow.isMaximized(),
    })
    return fullscreen
  }

  function toggleFullscreen() {
    return setFullscreen(!(videoWindow?.isFullScreen() || false))
  }

  function foreground() {
    if (!overlayWindow || overlayWindow.isDestroyed()) return false
    if (videoWindow && !videoWindow.isDestroyed() && videoWindow.isMinimized()) videoWindow.restore()
    overlayWindow.show()
    overlayWindow.focus()
    return true
  }

  function getState() {
    return {
      fullscreen: Boolean(videoWindow?.isFullScreen()),
      maximized: Boolean(videoWindow?.isMaximized()),
    }
  }

  return {
    create,
    destroy,
    foreground,
    getOverlayWindow: () => overlayWindow,
    getState,
    getVideoWindow: () => videoWindow,
    hide,
    setFullscreen,
    setTitle,
    showOverlay,
    showShell,
    showVideoFromLaunchState,
    syncBounds,
    toggleFullscreen,
  }
}

module.exports = { createPlayerWindowManager }
