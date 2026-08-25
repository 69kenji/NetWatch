const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const root = path.resolve(__dirname, '..')
const read = relative => fs.readFileSync(path.join(root, relative), 'utf8')
const main = read('electron/main.js')
const preload = read('electron/preload.js')
const setupHtml = read('electron/setup.html')
const setupRenderer = read('electron/setup-renderer.js')
const prowlarrHtml = read('electron/prowlarr-setup.html')
const prowlarrRenderer = read('electron/prowlarr-setup-renderer.js')
const settings = read('src/components/SettingsView.tsx')
const secureConfig = read('docker/secure_config.py')
const subtitleService = read('backend/services/subtitles.py')
const tracks = read('src/components/player/TracksPanel.tsx')

test('1.0.6 onboarding requires TMDB but allows subtitle providers to be skipped', () => {
  assert.match(setupRenderer, /const apiComplete = configured\.tmdb/)
  assert.doesNotMatch(setupRenderer, /configured\.tmdb && configured\.opensubtitles && configured\.subdl/)
  assert.match(setupHtml, /OpenSubtitles <span class="optional-label">Optional<\/span>/)
  assert.match(setupHtml, /SubDL <span class="optional-label">Optional<\/span>/)
  assert.match(main, /const apiComplete = Boolean\(configured\.tmdb\)/)
  assert.match(secureConfig, /REQUIRED_API_KEYS = \{"tmdb", "prowlarr"\}/)
})

test('API completion finishes first run when Prowlarr was already configured', () => {
  assert.match(main, /function setupReadyToFinish\(state\)/)
  assert.match(main, /configured\.tmdb && configured\.prowlarr/)
  assert.match(main, /function continueFirstRunAfterApi\(state\)[\s\S]*setupReadyToFinish\(state\)[\s\S]*finishFirstRun\(\)/)
  assert.match(main, /const next = await setupStateForRenderer\(\)[\s\S]*continueFirstRunAfterApi\(next\)[\s\S]*return \{ ok: true, state: next \}/)
})

test('credential fields enforce the supported exact shapes before privileged submission', () => {
  assert.match(setupHtml, /id="tmdb"[^>]*maxlength="32"/)
  assert.match(setupHtml, /id="opensubtitles"[^>]*maxlength="32"/)
  assert.match(setupHtml, /prefixed-secret-input"><span>subdl_<\/span><input id="subdl"[^>]*maxlength="43"/)
  assert.match(prowlarrHtml, /id="prowlarrKey"[^>]*maxlength="32"/)
  assert.match(prowlarrRenderer, /REQUIRED_KEY_LENGTH = 32/)
  assert.match(main, /cleaned\.length !== 49/)
  assert.match(main, /cleaned\.slice\(6\)\.length !== 43/)
  assert.match(secureConfig, /SUBDL_SUFFIX_LENGTH = 43/)
  assert.match(secureConfig, /CREDENTIAL_LENGTHS = \{[\s\S]*"tmdb": 32[\s\S]*"opensubtitles": 32[\s\S]*"prowlarr": 32/)
})

test('Settings receives status only and can submit only transient optional subtitle candidates', () => {
  assert.match(preload, /getCredentialStatus: \(\) => ipcRenderer\.invoke\('runtime:get-credential-status'\)/)
  assert.match(preload, /setSubtitleCredential: \(provider, candidate\)/)
  assert.doesNotMatch(preload, /getApiKey|getCredentialValue|readCredential/)
  assert.match(settings, /Saved API keys are never displayed/)
  assert.match(settings, /configured \? 'Replace' : 'Add'/)
  assert.match(settings, /Paste only what comes after subdl_/)
  assert.match(main, /return \{[\s\S]*tmdb: Boolean\(configured\.tmdb\)[\s\S]*prowlarr: Boolean\(configured\.prowlarr\)[\s\S]*opensubtitles: Boolean\(configured\.opensubtitles\)[\s\S]*subdl: Boolean\(configured\.subdl\)/)
  assert.match(secureConfig, /if action == "set-optional-api"/)
})

test('optional subtitle search skips absent providers without treating absence as a provider error', () => {
  assert.match(subtitleService, /"status": "not_configured"/)
  assert.match(tracks, /Online subtitles are not configured\. Add OpenSubtitles or SubDL in Settings\./)
})

test('security patch working notes are not shipped in the repository', () => {
  assert.equal(fs.existsSync(path.join(root, 'SECURITY_PATCH_NOTES.md')), false)
})
