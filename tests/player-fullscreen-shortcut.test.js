const test = require('node:test')
const assert = require('node:assert/strict')

const { playerFullscreenShortcutAction } = require('../electron/player-shortcuts')

test('F11 keydown toggles native player fullscreen', () => {
  assert.equal(playerFullscreenShortcutAction({ key: 'F11', type: 'keyDown', isAutoRepeat: false }), 'toggle')
})

test('F11 repeat and keyup are suppressed without toggling twice', () => {
  assert.equal(playerFullscreenShortcutAction({ key: 'F11', type: 'keyDown', isAutoRepeat: true }), 'suppress')
  assert.equal(playerFullscreenShortcutAction({ key: 'F11', type: 'keyUp', isAutoRepeat: false }), 'suppress')
})

test('other keys are left to the existing player shortcuts', () => {
  assert.equal(playerFullscreenShortcutAction({ key: 'f', type: 'keyDown', isAutoRepeat: false }), 'ignore')
  assert.equal(playerFullscreenShortcutAction({ key: 'Escape', type: 'keyDown', isAutoRepeat: false }), 'ignore')
})
