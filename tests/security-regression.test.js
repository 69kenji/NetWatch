const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const root = path.resolve(__dirname, '..')
const read = relative => fs.readFileSync(path.join(root, relative), 'utf8')
const main = read('electron/main.js')
const mainPreload = read('electron/preload.js')
const playerPreload = read('electron/player-preload.js')
const torrentRoutes = read('backend/routes/torrents.py')
const releaseSearch = read('backend/services/release_search.py')
const secureConfig = read('docker/secure_config.py')
const networkVerifier = read('docker/verify-networking.py')
const bootstrapVerifier = read('docker/verify-vpn-bootstrap.py')
const indexHtml = read('index.html')
const playerHtml = read('player.html')
const packageJson = JSON.parse(read('package.json'))
const runtimeVersion = read('packaging/runtime-version.txt').trim()


test('provider download URLs remain backend-only behind opaque release references', () => {
  assert.match(releaseSearch, /ReleaseReferenceStore\.issue/)
  assert.match(releaseSearch, /if key not in \{"source_url", "magnet"\}/)
  assert.match(torrentRoutes, /release_ref/)
  assert.doesNotMatch(read('src/types/torrents.ts'), /source_url|magnet\??:/)
})


test('obsolete destructive await-ready route is gone', () => {
  assert.doesNotMatch(torrentRoutes, /@router\.(?:get|api_route)\("\/await-ready/)
  assert.doesNotMatch(torrentRoutes, /reject_candidate_and_cleanup/)
})


test('player overlay uses least-privilege preload and IPC sender checks', () => {
  assert.match(main, /preload: path\.join\(__dirname, 'player-preload\.js'\)/)
  assert.doesNotMatch(playerPreload, /runtime:/)
  assert.doesNotMatch(playerPreload, /window:/)
  assert.doesNotMatch(playerPreload, /openTorrent/)
  assert.match(mainPreload, /openTorrent/)
  assert.doesNotMatch(mainPreload, /getSession|getState|getPreparation|command:|toggleFullscreen/)
  assert.match(main, /ipcMain\.handle\('player:open-torrent',[\s\S]*?assertMainRendererSender/)
  assert.match(main, /ipcMain\.handle\('player:command',[\s\S]*?assertPlayerRendererSender/)
  assert.match(main, /ipcMain\.handle\('runtime:get-status',[\s\S]*?assertMainRendererSender/)
})


test('packaged renderer has an explicit secure app origin and CSP', () => {
  assert.match(main, /registerSchemesAsPrivileged/)
  assert.match(main, /app:\/\/netwatch\/index\.html/)
  assert.match(indexHtml, /Content-Security-Policy/)
  assert.match(playerHtml, /Content-Security-Policy/)
  assert.match(indexHtml, /object-src 'none'/)
  assert.match(playerHtml, /object-src 'none'/)
})


test('VPN hooks and verifiers enforce exact control-port and kill-switch rules', () => {
  assert.match(secureConfig, /--dports \{NETWATCH_CONTROL_PORTS\} -j REJECT/)
  for (const source of [networkVerifier, bootstrapVerifier]) {
    assert.match(source, /iptables -C OUTPUT/)
    assert.match(source, /iptables -C INPUT -i wg0/)
    assert.match(source, /8000,8081,8191,9696/)
  }
})



test('1.0.5 packaged runtime forces an upgrade from the released 1.0.4 runtime', () => {
  assert.equal(runtimeVersion, '1.0.5-pkg38')
  assert.notEqual(runtimeVersion, '1.0.4-pkg37')
  assert.match(main, /currentRuntimeVersion !== expectedRuntimeVersion/)
  assert.match(main, /packagedRuntimeUpdated = true/)
  assert.match(main, /upArgs\.push\('--build'\)/)
  assert.match(read('src/types/torrents.ts'), /NetWatch runtime is out of date/)
})

test('Windows packaging does not require a local code-signing certificate', () => {
  assert.equal(packageJson.scripts['package:dir'], 'npm run build:renderer && electron-builder --win --dir')
  assert.equal(packageJson.scripts['package:win'], 'npm run build:renderer && electron-builder --win nsis')
  assert.equal(packageJson.scripts['verify:release-helper'], undefined)
  assert.equal(packageJson.scripts['verify:release-installer'], undefined)
  assert.equal(fs.existsSync(path.join(root, 'scripts/verify-release-security.js')), false)
})
