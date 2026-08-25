const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const root = path.resolve(__dirname, '..')
const installer = fs.readFileSync(path.join(root, 'build/installer.nsh'), 'utf8')
const helperMain = fs.readFileSync(path.join(root, 'native/prerequisite-helper/main.go'), 'utf8')
const helperProbe = fs.readFileSync(path.join(root, 'native/prerequisite-helper/probe.go'), 'utf8')
const helperDocker = fs.readFileSync(path.join(root, 'native/prerequisite-helper/docker.go'), 'utf8')
const helperProcess = fs.readFileSync(path.join(root, 'native/prerequisite-helper/process.go'), 'utf8')
const helperState = fs.readFileSync(path.join(root, 'native/prerequisite-helper/state.go'), 'utf8')
const helperSignature = fs.readFileSync(path.join(root, 'native/prerequisite-helper/signature.go'), 'utf8')
const runtimeVersion = fs.readFileSync(path.join(root, 'packaging/runtime-version.txt'), 'utf8').trim()
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'))

test('1.0.6 installer packages a native prerequisite helper and no PowerShell host', () => {
  assert.equal(pkg.version, '1.0.6')
  assert.equal(runtimeVersion, '1.0.6-pkg39')
  assert.ok(fs.existsSync(path.join(root, 'build/netwatch-prerequisites.exe')))
  assert.ok(fs.existsSync(path.join(root, 'native/prerequisite-helper/main.go')))
  assert.equal(fs.existsSync(path.join(root, 'build/prerequisites.ps1')), false)

  assert.match(installer, /netwatch-prerequisites\.exe/)
  assert.match(installer, /NetWatchPrereqHelper/)
  assert.doesNotMatch(installer, /powershell\.exe/i)
  assert.doesNotMatch(installer, /ExecutionPolicy/i)
  assert.doesNotMatch(installer, /EncodedCommand/i)
  assert.doesNotMatch(installer, /prerequisites\.ps1/i)
})

test('native prerequisite command surface is fixed-purpose', () => {
  for (const action of [
    'Probe',
    'InstallOrUpdateWslElevated',
    'InstallUbuntu',
    'InitializeDistro',
    'InstallDocker',
    'StartDocker',
  ]) {
    assert.match(helperMain, new RegExp(`"${action}"`))
  }
  assert.match(helperMain, /unsupported action/)
  assert.doesNotMatch(helperMain, /powershell/i)
  assert.doesNotMatch(helperMain, /cmd\.exe/i)
  assert.doesNotMatch(helperMain, /EncodedCommand/i)
})

test('installer detects helper interruption through completion and heartbeat state', () => {
  assert.match(installer, /"Run" "Complete"/)
  assert.match(installer, /"Run" "Heartbeat"/)
  assert.match(installer, /NetWatchRunStaleTicks >= 60/)
  assert.match(installer, /stopped reporting progress/i)
  assert.match(installer, /Do not reset or unregister WSL automatically/i)
})

test('Ubuntu readiness requires a real non-root default user', () => {
  assert.match(helperProbe, /DefaultUid/)
  assert.match(helperProbe, /distro\.DefaultUID == 0/)
  assert.match(helperProbe, /"getent", "passwd", uid/)
  assert.match(helperProbe, /"id", "-u"/)
  assert.match(installer, /DistroProvisioned/)
})

test('Docker bootstrap keeps pinned host, bounded size, and Docker signer verification', () => {
  assert.match(helperDocker, /desktop\.docker\.com/)
  assert.match(helperDocker, /maximumDockerInstallerBytes int64 = 1610612736/)
  assert.match(helperDocker, /len\(via\) >= 5/)
  assert.match(helperSignature, /WinVerifyTrust/)
  assert.match(helperSignature, /2\.5\.4\.10/)
  assert.match(helperSignature, /Docker Inc/)
})


test('helper state output is constrained and written atomically', () => {
  assert.match(helperMain, /validStatePath/)
  assert.match(helperMain, /netwatch-prerequisites\.ini/)
  assert.match(helperMain, /netwatch-prerequisites-elevated\.ini/)
  assert.match(helperMain, /os\.TempDir\(\)/)
  assert.match(helperState, /MoveFileExW/)
  assert.match(helperState, /moveFileReplaceExisting\|moveFileWriteThrough/)
  assert.match(helperState, /time\.NewTicker\(2 \* time\.Second\)/)
})

test('Ubuntu first-run gets a real interactive Windows console', () => {
  assert.match(helperProcess, /func runInteractive[\s\S]*?syscall\.CreateProcess/)
  assert.match(helperProcess, /createNewConsole/)
  assert.match(helperProcess, /no STARTF_USESTDHANDLES/)
  assert.match(helperProcess, /blank WSL console/)
})

test('Docker installer executes directly through Windows ShellExecute, never a command shell', () => {
  assert.match(helperProcess, /ShellExecuteExW/)
  assert.match(helperProcess, /seeMaskNoCloseProcess/)
  assert.match(helperProcess, /GetExitCodeProcess/)
  assert.doesNotMatch(helperProcess, /powershell\.exe/i)
  assert.doesNotMatch(helperProcess, /cmd\.exe/i)
  assert.match(fs.readFileSync(path.join(root, 'native/prerequisite-helper/actions.go'), 'utf8'), /shellExecuteAndWait\(installer, \[\]string\{"install", "--user"\}/)
})
