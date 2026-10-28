const { contextBridge, ipcRenderer } = require('electron')
const appearanceTokens = ipcRenderer.sendSync('appearance:setup-initial')
window.addEventListener('DOMContentLoaded', () => {
  for (const [key, value] of Object.entries(appearanceTokens || {})) {
    if (/^--nw-[a-z-]+$/.test(key)) document.documentElement.style.setProperty(key, String(value))
  }
})

contextBridge.exposeInMainWorld('netwatchProwlarrSetup', {
  prepare: () => ipcRenderer.invoke('prowlarr-setup:prepare'),
  open: () => ipcRenderer.invoke('prowlarr-setup:open'),
  submitKey: (key) => ipcRenderer.invoke('prowlarr-setup:submit', key),
})
