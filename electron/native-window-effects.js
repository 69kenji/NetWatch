'use strict'

const fs = require('node:fs')
const path = require('node:path')
const { spawnSync } = require('node:child_process')

function resolveSurfaceHelper() {
  if (process.platform !== 'win32') return null
  const candidates = []
  if (process.resourcesPath) candidates.push(path.join(process.resourcesPath, 'native', 'netwatch-surface-helper.exe'))
  candidates.push(path.join(__dirname, '..', 'resources', 'native', 'netwatch-surface-helper.exe'))
  return candidates.find(candidate => fs.existsSync(candidate)) || null
}

function nativeWindowHandleToDecimal(win) {
  const handle = win.getNativeWindowHandle()
  if (!Buffer.isBuffer(handle) || handle.length < 4) throw new Error('Electron did not return a valid native window handle')
  return (handle.length >= 8 ? handle.readBigUInt64LE(0) : BigInt(handle.readUInt32LE(0))).toString(10)
}

function setClientFrameExtension(win, enabled) {
  if (process.platform !== 'win32' || !win || win.isDestroyed()) return { applied: false, reason: 'unsupported' }
  const helper = resolveSurfaceHelper()
  if (!helper) return { applied: false, reason: 'helper-missing' }

  const result = spawnSync(helper, [
    'frame',
    '--window', nativeWindowHandleToDecimal(win),
    '--pid', String(process.pid),
    '--mode', enabled ? 'extend' : 'reset',
  ], {
    shell: false,
    windowsHide: true,
    encoding: 'utf8',
    timeout: 2000,
  })

  if (result.error) throw result.error
  if (result.status !== 0) {
    const detail = String(result.stderr || '').trim()
    throw new Error(detail || `DWM frame helper exited with code ${result.status}`)
  }
  return { applied: true }
}

module.exports = { setClientFrameExtension }
