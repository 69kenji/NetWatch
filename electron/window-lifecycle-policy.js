function shouldMinimizeOnClose({ onClose, trayReady, quitting }) {
  return onClose === 'minimize-to-tray' && Boolean(trayReady) && !quitting
}

module.exports = { shouldMinimizeOnClose }
