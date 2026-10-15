'use strict'

const { dialog, ipcMain } = require('electron')

function registerLocalLibraryIpc({ library, player, desktopShell, backendJson }) {
  let picking = false
  ipcMain.handle('library:list', event => { desktopShell.assertMainRendererSender(event); return library.refresh() })
  ipcMain.handle('library:add-folder', async event => {
    desktopShell.assertMainRendererSender(event)
    if (picking) throw new Error('A folder picker is already open')
    picking = true
    try {
      const result = await dialog.showOpenDialog(desktopShell.getMainWindow(), { title: 'Add media folder', properties: ['openDirectory', 'dontAddToRecent'] })
      return result.canceled || !result.filePaths[0] ? library.state() : library.addFolder(result.filePaths[0])
    } finally { picking = false }
  })
  ipcMain.handle('library:remove-folder', async (event, id) => {
    desktopShell.assertMainRendererSender(event)
    const result = await dialog.showMessageBox(desktopShell.getMainWindow(), {
      type: 'question', title: 'Remove library folder?', message: 'Remove this folder and its saved matches from NetWatch?',
      detail: 'Your media files will not be deleted.', buttons: ['Cancel', 'Remove'], defaultId: 0, cancelId: 0,
    })
    return result.response === 1 ? library.removeFolder(id) : library.state()
  })
  ipcMain.handle('library:search', (event, query) => {
    desktopShell.assertMainRendererSender(event)
    if (typeof query !== 'string' || !query.trim() || query.length > 160) throw new Error('Enter a title (up to 160 characters)')
    return backendJson(`/api/metadata/search?query=${encodeURIComponent(query.trim())}`, {}, 35_000)
  })
  ipcMain.handle('library:match', (event, id, selection) => { desktopShell.assertMainRendererSender(event); return library.match(id, selection) })
  ipcMain.handle('library:play', (event, id) => { desktopShell.assertMainRendererSender(event); return player.openLocal(id) })
}

module.exports = { registerLocalLibraryIpc }
