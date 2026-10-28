'use strict'
const { app, dialog, ipcMain, nativeTheme } = require('electron')
const fs = require('node:fs/promises')
const path = require('node:path')
const { normalizeAppearance, resolveAppearance, validHex, IMAGE_ID } = require('../shared/appearance.mjs')
const { importImage, inspectImage, readBounded } = require('./background-image')

function createAppearanceController({ appSettings, profiles, desktopShell, player, setupController }) {
  const directory = path.join(app.getPath('userData'), 'appearance-images')
  let previewAccent = null, importing = false
  const get = () => ({ preferences: normalizeAppearance(appSettings.get().appearance), previewAccent,
    native: desktopShell.applyNativeAppearance(),
    reducedEffects: appSettings.get().resourceProfile === 'reduced' || nativeTheme.shouldUseHighContrastColors || nativeTheme.prefersReducedTransparency || app.getGPUFeatureStatus().gpu_compositing !== 'enabled' })
  const broadcast = () => {
    const state = get()
    desktopShell.sendToMain('appearance:changed', state)
    const overlay = player.getOverlayWindow()
    if (overlay && !overlay.isDestroyed()) overlay.webContents.send('appearance:changed', state)
    return state
  }
  const assertReader = event => {
    const main = desktopShell.getMainWindow(), overlay = player.getOverlayWindow()
    if (event.sender === main?.webContents) return desktopShell.assertMainRendererSender(event)
    if (event.sender === overlay?.webContents) return desktopShell.assertWindowSender(event, overlay, 'player appearance', desktopShell.playerRendererUrl())
    const setup = setupController.getActiveWindow()
    if (setup && event.sender === setup.webContents) return desktopShell.assertWindowSender(event, setup, 'setup appearance', setup.webContents.getURL())
    throw new Error('Appearance access denied.')
  }
  async function cleanup() {
    if (!profiles.isWritable() || importing) return
    try {
      const entries = await fs.readdir(directory, { withFileTypes: true })
      for (const entry of entries) {
        if (importing) return
        const referenced = new Set(profiles.value.profiles.map(profile => profile.settings.appearance?.background.imageId).filter(Boolean))
        if (!entry.isFile() || !/^[a-f0-9]{32}\.png$/u.test(entry.name) || referenced.has(entry.name.slice(0, -4))) continue
        await fs.unlink(path.join(directory, entry.name)).catch(() => {})
      }
    } catch (error) { if (error.code !== 'ENOENT') console.warn('[Appearance] Background cleanup will retry next launch.') }
  }
  ipcMain.on('appearance:initial', event => {
    try { assertReader(event); event.returnValue = get() } catch { event.returnValue = null }
  })
  ipcMain.on('appearance:setup-initial', event => {
    try { assertReader(event); event.returnValue = resolveAppearance(get().preferences).tokens } catch { event.returnValue = null }
  })
  ipcMain.handle('appearance:get', event => { assertReader(event); return get() })
  ipcMain.handle('appearance:update', async (event, patch) => {
    desktopShell.assertMainRendererSender(event)
    if (!patch || typeof patch !== 'object' || Array.isArray(patch) || Object.keys(patch).some(key => !['theme', 'accentColor', 'customAccentColor', 'density', 'materialBlur', 'background'].includes(key))) throw new Error('Invalid appearance settings.')
    if (patch.background != null && (typeof patch.background !== 'object' || Array.isArray(patch.background))) throw new Error('Invalid background settings.')
    if ('materialBlur' in patch && (!Number.isInteger(patch.materialBlur) || patch.materialBlur < 8 || patch.materialBlur > 28)) throw new Error('Interface blur must be an integer from 8 to 28 pixels.')
    const current = get().preferences
    if (patch.background && 'imageId' in patch.background && patch.background.imageId !== current.background.imageId && patch.background.imageId !== null) throw new Error('Import a background image first.')
    const next = normalizeAppearance({ ...current, ...patch, background: { ...current.background, ...patch.background } })
    appSettings.update({ appearance: next })
    previewAccent = null
    void cleanup()
    return broadcast()
  })
  nativeTheme.on('updated', broadcast)
  app.on('web-contents-created', (_event, contents) => {
    const resetPreview = () => { if (previewAccent && contents === desktopShell.getMainWindow()?.webContents) { previewAccent = null; broadcast() } }
    contents.on('render-process-gone', resetPreview)
    contents.on('did-start-navigation', (_event, _url, _inPlace, mainFrame) => { if (mainFrame) resetPreview() })
  })
  ipcMain.handle('appearance:preview', (event, color) => {
    desktopShell.assertMainRendererSender(event)
    if (color !== null && !validHex(color)) throw new Error('Invalid accent color.')
    previewAccent = color?.toUpperCase() || null
    return broadcast()
  })
  ipcMain.handle('appearance:image', async event => {
    desktopShell.assertMainRendererSender(event)
    const id = get().preferences.background.imageId
    if (!id) return { imageId: null, data: null, error: null }
    try {
      if (!IMAGE_ID.test(id)) throw new Error('Invalid image')
      const png = await readBounded(path.join(directory, `${id}.png`))
      inspectImage(png, '.png')
      return { imageId: id, data: `data:image/png;base64,${png.toString('base64')}`, error: null }
    } catch { return { imageId: id, data: null, error: 'Background image is missing or unreadable. Choose another image or remove it.' } }
  })
  ipcMain.handle('appearance:import', async event => {
    desktopShell.assertMainRendererSender(event)
    if (importing) throw new Error('An image import is already in progress.')
    importing = true
    try {
      const profileId = profiles.state().activeId
      const selected = await dialog.showOpenDialog(desktopShell.getMainWindow(), { title: 'Choose background image', properties: ['openFile'], filters: [{ name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'webp'] }] })
      if (selected.canceled || selected.filePaths.length !== 1) return get()
      const imageId = await importImage(selected.filePaths[0], directory)
      if (profiles.state().activeId !== profileId) throw new Error('Profile changed. Select the image again.')
      const current = get().preferences
      appSettings.update({ appearance: { ...current, background: { ...current.background, imageId } } })
      return broadcast()
    } catch (error) {
      // Filesystem errors include local paths; never send those to the renderer.
      if (error.code || /Script failed|ERR_|Render frame|destroyed/iu.test(error.message || '')) throw new Error('The image could not be imported. Choose another local image.')
      throw error
    } finally { importing = false; await cleanup() }
  })
  return { get, refresh() { previewAccent = null; void cleanup(); return broadcast() }, cleanup }
}
module.exports = { createAppearanceController }
