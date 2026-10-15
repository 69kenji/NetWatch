'use strict'

const fs = require('node:fs')
const path = require('node:path')

function verifyWindowsBinary(filename) {
  if (!fs.existsSync(filename)) throw new Error(`Required player binary is missing: ${filename}`)
  const fd = fs.openSync(filename, 'r')
  try {
    const header = Buffer.alloc(64)
    const count = fs.readSync(fd, header, 0, header.length, 0)
    if (header.toString('ascii').startsWith('version https://git-lfs.github.com/spec/v1')) {
      throw new Error(`Git LFS pointer found instead of a player binary: ${filename}. Run git lfs pull, then rebuild the installer.`)
    }
    if (count !== 64 || header.readUInt16LE(0) !== 0x5a4d) {
      throw new Error(`Invalid Windows player binary: ${filename}`)
    }
    const peOffset = header.readUInt32LE(0x3c)
    const signature = Buffer.alloc(4)
    if (peOffset < 64 || peOffset > fs.fstatSync(fd).size - 4 ||
        fs.readSync(fd, signature, 0, 4, peOffset) !== 4 || signature.readUInt32LE(0) !== 0x00004550) {
      throw new Error(`Invalid Windows executable header: ${filename}`)
    }
  } finally {
    fs.closeSync(fd)
  }
}

function verifyRuntime(context) {
  if (context.electronPlatformName !== 'win32') return
  const root = context.packager.projectDir
  for (const relative of [
    'resources/mpv/mpv.exe',
    'resources/mpv/mpv.com',
    'resources/mpv/d3dcompiler_43.dll',
    'resources/native/netwatch-surface-helper.exe',
  ]) verifyWindowsBinary(path.join(root, relative))
}

module.exports = verifyRuntime

if (require.main === module) {
  verifyRuntime({ packager: { projectDir: path.resolve(__dirname, '..') }, electronPlatformName: 'win32' })
  console.log('Windows player binaries verified.')
}
