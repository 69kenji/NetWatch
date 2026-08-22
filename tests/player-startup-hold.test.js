const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const { MpvController, startupPlaybackReady } = require('../electron/mpv-controller')

const root = path.resolve(__dirname, '..')
const controllerSource = fs.readFileSync(path.join(root, 'electron/mpv-controller.js'), 'utf8')

test('startup playback readiness requires an active loaded video decoder and real duration', () => {
  const ready = { idle: false, duration: 3600, hwdecCurrent: 'd3d11va' }
  assert.equal(startupPlaybackReady(ready), true)
  assert.equal(startupPlaybackReady({ ...ready, hwdecCurrent: 'no' }), true)
  assert.equal(startupPlaybackReady({ ...ready, idle: true }), false)
  assert.equal(startupPlaybackReady({ ...ready, hwdecCurrent: null }), false)
  assert.equal(startupPlaybackReady({ ...ready, duration: 0 }), false)
  assert.equal(startupPlaybackReady({ ...ready, duration: Number.NaN }), false)
})

test('startup readiness waiter does not release until the video decoder is loaded', async () => {
  const controller = new MpvController()
  controller.startupHoldActive = true
  const wait = controller._waitForStartupVideoReady()
  let resolved = false
  void wait.then(() => { resolved = true })

  controller._setState({ idle: false, duration: 3600, hwdecCurrent: null })
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(resolved, false)

  controller._setState({ hwdecCurrent: 'no' })
  await wait
  assert.equal(resolved, true)
})

test('initial sources are launched paused and released after startup readiness', () => {
  assert.match(controllerSource, /if \(initialSource\) \{[\s\S]*?args\.push\('--pause'\)[\s\S]*?args\.push\(initialSource\)/)
  assert.match(controllerSource, /await this\._waitForStartupVideoReady\(\)/)
  assert.match(controllerSource, /await this\.request\(\['set_property', 'pause', false\], 5000\)/)
  assert.match(controllerSource, /this\.startupHoldActive = false/)
})

test('stopping mpv rejects a pending startup readiness wait', async () => {
  const controller = new MpvController()
  controller.startupHoldActive = true
  const wait = controller._waitForStartupVideoReady()
  await controller.stop({ graceful: false })
  await assert.rejects(wait, /stopped during startup/)
})
