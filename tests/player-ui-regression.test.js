const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const root = path.resolve(__dirname, '..')
const player = fs.readFileSync(path.join(root, 'src/components/player/Player.tsx'), 'utf8')
const buffering = fs.readFileSync(path.join(root, 'src/components/player/BufferingOverlay.tsx'), 'utf8')
const tracks = fs.readFileSync(path.join(root, 'src/components/player/TracksPanel.tsx'), 'utf8')
const network = fs.readFileSync(path.join(root, 'src/components/player/NetworkPanel.tsx'), 'utf8')
const styles = fs.readFileSync(path.join(root, 'src/styles/player.css'), 'utf8')
const main = fs.readFileSync(path.join(root, 'electron/main.js'), 'utf8')

test('Space is handled before focused-button shortcut suppression', () => {
  const space = player.indexOf("if (event.code === 'Space')")
  const buttonGuard = player.indexOf("tagName === 'BUTTON'")
  assert.ok(space >= 0)
  assert.ok(buttonGuard >= 0)
  assert.ok(space < buttonGuard)
  assert.match(player, /document\.activeElement instanceof HTMLButtonElement/)
  assert.match(player, /addEventListener\('keydown', handleKeyDown, true\)/)
})

test('floating player menus have a click-consuming outside scrim', () => {
  assert.match(player, /className="player-panel-scrim"/)
  assert.match(player, /setTracksPanelOpen\(false\)/)
  assert.match(player, /setNetworkPanelOpen\(false\)/)
  assert.match(styles, /\.player-side-panel\.player-floating-panel/)
  assert.match(styles, /bottom: 76px/)
})

test('audio and subtitles are consolidated into Tracks', () => {
  assert.match(player, /<TracksPanel/)
  assert.match(player, /title="Tracks \(S\)"/)
  assert.match(tracks, /<strong>Tracks<\/strong>/)
  assert.match(tracks, /<strong>Audio<\/strong>/)
  assert.match(tracks, /<strong>Subtitles<\/strong>/)
  assert.match(tracks, /<strong>Online<\/strong>/)
  assert.doesNotMatch(player, /PlayerSettingsPanel/)
})

test('Network replaces settings with live torrent telemetry', () => {
  assert.match(player, /<NetworkPanel/)
  assert.match(player, /title="Network"/)
  assert.match(network, /Download speed/)
  assert.match(network, /Downloaded/)
  assert.match(network, /Connected peers/)
  assert.match(network, /Buffer ahead/)
  assert.match(network, /Torrent state/)
  assert.match(network, /preparation\?\.progress/)
  assert.match(network, /preparation\?\.peers/)
})

test('Escape closes either floating player menu', () => {
  assert.match(player, /if \(tracksPanelOpen \|\| networkPanelOpen\)/)
  assert.match(player, /setTracksPanelOpen\(false\)/)
  assert.match(player, /setNetworkPanelOpen\(false\)/)
})

test('preparation overlay exposes fullscreen immediately', () => {
  assert.match(player, /fullscreen=\{fullscreen\}/)
  assert.match(player, /onToggleFullscreen=\{\(\) => void toggleFullscreen\(\)\}/)
  assert.match(buffering, /className="player-buffer-fullscreen"/)
})

test('skip controls use Iconoir Refresh geometry with an unmirrored ten label', () => {
  assert.match(player, /<SkipTenIcon direction="back"/)
  assert.match(player, /<SkipTenIcon direction="forward"/)
  assert.match(player, /M21\.8883 13\.5C21\.1645 18\.3113/)
  assert.match(player, /M17 8H21\.4C21\.7314 8/)
  assert.match(player, /transform="translate\(24 0\) scale\(-1 1\)"/)
  assert.match(player, />\s*10\s*<\/text>/)
  const mirror = player.indexOf('transform="translate(24 0) scale(-1 1)"')
  const label = player.indexOf('>\n        10\n      </text>')
  assert.ok(mirror >= 0 && label > mirror)
})

test('fullscreen host focus restores overlay foreground', () => {
  assert.match(main, /function restoreFullscreenPlayerForeground/)
  assert.match(main, /playerVideoWindow\.on\('focus', \(\) => restoreFullscreenPlayerForeground\(0\)\)/)
  assert.match(main, /playerOverlayWindow\.moveTop\(\)/)
  assert.match(main, /playerOverlayWindow\.focus\(\)/)
})

test('volume popover centering is independent of motion transforms', () => {
  const popover = styles.match(/\.volume-popover \{([\s\S]*?)\n\}/)?.[1] || ''
  assert.match(popover, /left: 50%/)
  assert.match(popover, /translate: -50% 0/)
  assert.doesNotMatch(popover, /transform: translateX\(-50%\)/)
})

test('long seek restart state activates the cinematic buffering overlay', () => {
  const controller = fs.readFileSync(path.join(root, 'electron/mpv-controller.js'), 'utf8')
  assert.match(controller, /'seeking'/)
  assert.match(controller, /seekOutsideBufferedWindow/)
  assert.match(controller, /seekBuffering: true/)
  assert.match(controller, /message\.event === 'playback-restart'/)
  assert.match(player, /nativeState\?\.seekBuffering/)
  assert.match(player, /nativeState\?\.seeking/)
  assert.match(player, /nativeState\?\.pausedForCache \|\| seekRestartBuffering/)
})
