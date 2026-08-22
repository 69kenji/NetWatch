const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('netwatchSetup', {
  getState: () => ipcRenderer.invoke('setup:get-state'),
  chooseWireGuard: () => ipcRenderer.invoke('setup:choose-wireguard'),
  verifyVpn: () => ipcRenderer.invoke('setup:verify-vpn'),
  submitApiCredentials: (payload) => ipcRenderer.invoke('setup:submit-api', payload),
  openCredentialSite: (site) => ipcRenderer.invoke('setup:open-credential-site', site),
})
