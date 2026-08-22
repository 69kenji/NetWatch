const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('netwatchProwlarrSetup', {
  prepare: () => ipcRenderer.invoke('prowlarr-setup:prepare'),
  open: () => ipcRenderer.invoke('prowlarr-setup:open'),
  submitKey: (key) => ipcRenderer.invoke('prowlarr-setup:submit', key),
})
