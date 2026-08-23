const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const root = path.resolve(__dirname, '..')
const controller = fs.readFileSync(path.join(root, 'electron/mpv-controller.js'), 'utf8')
const helper = fs.readFileSync(path.join(root, 'native/surface-helper/main.go'), 'utf8')
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'))

test('normal player path contains no PowerShell, compiler, WMI, or custom mpv launcher', () => {
  assert.doesNotMatch(controller, /spawn\(['"]powershell\.exe['"]/i)
  assert.doesNotMatch(controller, /EncodedCommand/i)
  assert.doesNotMatch(controller, /ExecutionPolicy/i)
  assert.doesNotMatch(controller, /Add-Type/i)
  assert.doesNotMatch(controller, /Invoke-CimMethod/i)
  assert.doesNotMatch(controller, /New-CimInstance/i)
  assert.doesNotMatch(controller, /csc\.exe/i)
  assert.doesNotMatch(controller, /netwatch-player-helper\.exe/i)
  assert.doesNotMatch(controller, /CREATE_BREAKAWAY_FROM_JOB/i)
})

test('Windows player launches mpv directly as a detached Electron child', () => {
  assert.match(controller, /child = spawn\(executable, args, \{/)
  assert.match(controller, /shell: false/)
  assert.match(controller, /detached: true/)
  assert.match(controller, /launchMode: 'electron_detached'/)
  assert.match(controller, /candidates\.push\(path\.join\(process\.resourcesPath, 'mpv', 'mpv\.exe'\)\)/)
  const directLaunch = controller.match(/async function spawnMpvOnWindows[\s\S]*?\n}\n\nfunction startMpvSurfaceWatcherOnWindows/)?.[0] || ''
  assert.doesNotMatch(directLaunch, /windowsHide: true/)
  assert.match(controller, /this\.process = launched\.child/)
})

test('pkg35 packages a surface-only helper', () => {
  assert.match(controller, /netwatch-surface-helper\.exe/)
  assert.match(controller, /startMpvSurfaceWatcherOnWindows/)

  const nativeResource = pkg.build.extraResources.find(item => item.from === 'resources/native')
  assert.ok(nativeResource)
  assert.equal(nativeResource.to, 'native')
  assert.ok(nativeResource.filter.includes('netwatch-surface-helper.exe'))

  assert.ok(fs.existsSync(path.join(root, 'resources/native/netwatch-surface-helper.exe')))
  assert.ok(fs.existsSync(path.join(root, 'native/surface-helper/main.go')))
})

test('surface helper cannot launch processes or invoke scripting hosts', () => {
  assert.match(helper, /EnumChildWindows/)
  assert.match(helper, /ShowWindow/)
  assert.match(helper, /SetWindowPos/)
  assert.match(helper, /os\.Args\[1\] != "watch"/)
  assert.doesNotMatch(helper, /CreateProcess/i)
  assert.doesNotMatch(helper, /powershell/i)
  assert.doesNotMatch(helper, /cmd\.exe/i)
  assert.doesNotMatch(helper, /WMI/i)
  assert.doesNotMatch(helper, /ShellExecute/i)
})
