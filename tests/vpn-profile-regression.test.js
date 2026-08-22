const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const root = path.resolve(__dirname, '..')
const main = fs.readFileSync(path.join(root, 'electron/main.js'), 'utf8')
const preload = fs.readFileSync(path.join(root, 'electron/preload.js'), 'utf8')
const setupPreload = fs.readFileSync(path.join(root, 'electron/setup-preload.js'), 'utf8')
const setupRenderer = fs.readFileSync(path.join(root, 'electron/setup-renderer.js'), 'utf8')
const setupHtml = fs.readFileSync(path.join(root, 'electron/setup.html'), 'utf8')
const settings = fs.readFileSync(path.join(root, 'src/components/SettingsView.tsx'), 'utf8')
const { VPNBOOK_REFRESH_URL, normalizeVpnProfileType, wireGuardFileTimestamps } = require('../electron/vpn-profile')

test('VPNBook support remains standard WireGuard plus UX metadata', () => {
  assert.equal(normalizeVpnProfileType('vpnbook'), 'vpnbook')
  assert.equal(normalizeVpnProfileType('generic'), 'generic')
  assert.equal(normalizeVpnProfileType('unexpected'), 'generic')
  assert.equal(VPNBOOK_REFRESH_URL, 'https://www.vpnbook.com/freevpn/wireguard-vpn')
  assert.match(main, /const action = stageOnly \? 'stage-wireguard' : 'import-wireguard'/)
  assert.match(main, /secureConfigAction\(action,/)
  assert.match(main, /args: \[normalizedType, imported\.timestamps\.sourceCreatedAt, imported\.timestamps\.sourceModifiedAt\]/)
})

test('WireGuard import captures plausible Windows creation and modification times only', () => {
  const now = Date.UTC(2026, 7, 22, 12, 0, 0)
  const result = wireGuardFileTimestamps({
    birthtimeMs: now - 60_000,
    mtimeMs: now - 120_000,
  }, now)
  assert.equal(result.sourceCreatedAt, new Date(now - 60_000).toISOString())
  assert.equal(result.sourceModifiedAt, new Date(now - 120_000).toISOString())
  const future = wireGuardFileTimestamps({ birthtimeMs: now + 60 * 60_000, mtimeMs: 0 }, now)
  assert.equal(future.sourceCreatedAt, '')
  assert.equal(future.sourceModifiedAt, '')
})

test('first-run setup exposes Generic WireGuard and VPNBook without changing the VPN mechanism', () => {
  assert.match(setupHtml, /<option value="generic">Generic WireGuard<\/option>/)
  assert.match(setupHtml, /<option value="vpnbook">VPNBook<\/option>/)
  assert.match(setupRenderer, /chooseWireGuard\(state\.profileType\)/)
  assert.match(setupRenderer, /setVpnProfileType\(nextType\)/)
  assert.match(setupRenderer, /openVpnBook\(\)/)
  assert.match(setupPreload, /setup:set-vpn-profile-type/)
  assert.match(setupPreload, /setup:open-vpnbook/)
})

test('settings can relabel, replace, renew and restart without exposing arbitrary paths or URLs', () => {
  assert.match(preload, /runtime:get-vpn-profile/)
  assert.match(preload, /runtime:set-vpn-profile-type/)
  assert.match(preload, /runtime:replace-wireguard/)
  assert.match(preload, /runtime:open-vpnbook/)
  assert.match(preload, /runtime:restart-app/)
  assert.match(settings, /Generic WireGuard/)
  assert.match(settings, /VPNBook/)
  assert.match(settings, /Estimated profile expiry/)
  assert.match(settings, /Get new VPNBook config/)
  assert.match(settings, /Replace configuration/)
  assert.match(settings, /Restart NetWatch/)
  assert.match(main, /shell\.openExternal\(VPNBOOK_REFRESH_URL\)/)
  assert.match(main, /showOpenDialog\(parentWindow/)
  assert.match(main, /stageOnly: true/)
  assert.match(main, /pendingVpn = Boolean\(setupState\?\.pending\?\.vpn\)/)
  assert.match(main, /mark-vpn-validated/)
})

test('VPNBook timer is explicitly informational and live VPN verification stays separate', () => {
  assert.match(settings, /Reminder only\. NetWatch still verifies the live tunnel and fails closed\./)
  assert.match(main, /ipcMain\.handle\('runtime:vpn-sanity'/)
  assert.match(main, /vpnSanityCheck\(\)/)
})
