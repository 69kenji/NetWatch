'use strict'

const crypto = require('node:crypto')
const fs = require('node:fs')
const path = require('node:path')

function sha256(filename) {
  const hash = crypto.createHash('sha256')
  const fd = fs.openSync(filename, 'r')
  const chunk = Buffer.allocUnsafe(1024 * 1024)
  try {
    for (let offset = 0; ;) {
      const count = fs.readSync(fd, chunk, 0, chunk.length, offset)
      if (!count) break
      hash.update(chunk.subarray(0, count))
      offset += count
    }
    return hash.digest('hex')
  } finally {
    fs.closeSync(fd)
  }
}

function verifyWindowsBinary(filename, expectedHash) {
  if (!fs.existsSync(filename)) throw new Error(`Required Windows binary is missing: ${filename}`)
  const fd = fs.openSync(filename, 'r')
  try {
    const header = Buffer.alloc(64)
    const count = fs.readSync(fd, header, 0, header.length, 0)
    if (header.toString('ascii').startsWith('version https://git-lfs.github.com/spec/v1')) {
      throw new Error(`Git LFS pointer found instead of a binary: ${filename}. Run git lfs pull, then rebuild the installer.`)
    }
    if (count !== 64 || header.readUInt16LE(0) !== 0x5a4d) throw new Error(`Invalid Windows binary: ${filename}`)
    const peOffset = header.readUInt32LE(0x3c)
    const signature = Buffer.alloc(4)
    if (peOffset < 64 || peOffset > fs.fstatSync(fd).size - 4 ||
        fs.readSync(fd, signature, 0, 4, peOffset) !== 4 || signature.readUInt32LE(0) !== 0x00004550) {
      throw new Error(`Invalid Windows executable header: ${filename}`)
    }
  } finally {
    fs.closeSync(fd)
  }
  const actualHash = sha256(filename)
  if (actualHash !== expectedHash) throw new Error(`Unexpected SHA-256 for ${filename}: ${actualHash}`)
}

function occurrences(text, value) {
  return text.split(value).length - 1
}

function verifyComposeParity(root) {
  const development = fs.readFileSync(path.join(root, 'docker/docker-compose.yml'), 'utf8')
  const packaged = fs.readFileSync(path.join(root, 'docker/docker-compose.packaged.yml'), 'utf8')
  const required = new Map([
    ['network_mode: "service:vpn"', 4],
    ['network_mode: "none"', 1],
    ['no-new-privileges:true', 2],
    ['read_only: true', 1],
    ['cap_drop:', 3],
    ['healthcheck:', 4],
    ['@sha256:', 2],
    ['127.0.0.1:', 8],
    ['depends_on:', 4],
  ])
  for (const [setting, minimum] of required) {
    const developmentCount = occurrences(development, setting)
    const packagedCount = occurrences(packaged, setting)
    if (developmentCount < minimum || packagedCount < minimum || developmentCount !== packagedCount) {
      throw new Error(`Docker security policy drift for "${setting}" (${developmentCount} development, ${packagedCount} packaged)`)
    }
  }
}

function verifyRuntime(context) {
  if (context.electronPlatformName !== 'win32') return
  const root = context.packager.projectDir
  const manifest = JSON.parse(fs.readFileSync(path.join(root, 'packaging/runtime-manifest.json'), 'utf8'))
  for (const [relative, expectedHash] of Object.entries(manifest.files)) verifyWindowsBinary(path.join(root, relative), expectedHash)
  verifyComposeParity(root)
}

module.exports = verifyRuntime

if (require.main === module) {
  verifyRuntime({ packager: { projectDir: path.resolve(__dirname, '..') }, electronPlatformName: 'win32' })
  console.log('Runtime binaries and Docker security policy verified.')
}
