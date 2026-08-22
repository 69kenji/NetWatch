function playerFullscreenShortcutAction(input) {
  if (!input || input.key !== 'F11') return 'ignore'
  if (input.type === 'keyDown' && !input.isAutoRepeat) return 'toggle'
  return 'suppress'
}

module.exports = { playerFullscreenShortcutAction }
