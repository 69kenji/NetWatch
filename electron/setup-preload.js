const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('netwatchSetup', {
  getState: () => ipcRenderer.invoke('setup:get-state'),
  chooseWireGuard: (profileType) => ipcRenderer.invoke('setup:choose-wireguard', profileType),
  setVpnProfileType: (profileType) => ipcRenderer.invoke('setup:set-vpn-profile-type', profileType),
  openVpnBook: () => ipcRenderer.invoke('setup:open-vpnbook'),
  verifyVpn: () => ipcRenderer.invoke('setup:verify-vpn'),
  submitApiCredentials: (payload) => ipcRenderer.invoke('setup:submit-api', payload),
  openCredentialSite: (site) => ipcRenderer.invoke('setup:open-credential-site', site),
})
