'use strict'

const fs = require('node:fs/promises')
const path = require('node:path')
const { randomBytes } = require('node:crypto')
const MAX_BYTES = 20 * 1024 * 1024
const MAX_PIXELS = 24_000_000
function checkDimensions(width, height) {
  if (!width || !height || width > 12000 || height > 12000 || width * height > MAX_PIXELS) throw new Error('Choose an image up to 24 megapixels and 12,000 pixels per side.')
}

function inspectImage(buffer, extension) {
  if (buffer.length < 24 || buffer.length > MAX_BYTES) throw new Error('Choose an image under 20 MB.')
  let width, height, type
  if (buffer.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) {
    type = 'png'
    if (buffer.toString('ascii', 12, 16) !== 'IHDR') throw new Error('Invalid PNG image.')
    width = buffer.readUInt32BE(16); height = buffer.readUInt32BE(20)
    for (let offset = 8; offset + 12 <= buffer.length;) {
      const length = buffer.readUInt32BE(offset), chunk = buffer.toString('ascii', offset + 4, offset + 8)
      if (length > buffer.length - offset - 12) throw new Error('Invalid PNG image.')
      if (chunk === 'acTL') throw new Error('Animated backgrounds are not supported.')
      offset += length + 12
    }
  } else if (buffer[0] === 255 && buffer[1] === 216) {
    type = 'jpeg'
    for (let offset = 2; offset < buffer.length;) {
      if (buffer[offset++] !== 255) throw new Error('Invalid JPEG image.')
      while (buffer[offset] === 255) offset++
      const marker = buffer[offset++]
      if (marker === 217 || marker === 218) break
      if (marker === 1 || marker >= 208 && marker <= 215) continue
      if (offset + 2 > buffer.length) break
      const size = buffer.readUInt16BE(offset)
      if (size < 2 || offset + size > buffer.length) throw new Error('Invalid JPEG image.')
      if ([192, 193, 194].includes(marker) && size >= 8) {
        const h = buffer.readUInt16BE(offset + 3), w = buffer.readUInt16BE(offset + 5)
        checkDimensions(w, h)
        if (width && (width !== w || height !== h)) throw new Error('Inconsistent JPEG dimensions.')
        width = w; height = h
      }
      offset += size
    }
  } else if (buffer.toString('ascii', 0, 4) === 'RIFF' && buffer.toString('ascii', 8, 12) === 'WEBP') {
    type = 'webp'
    if (buffer.readUInt32LE(4) + 8 !== buffer.length) throw new Error('Invalid WebP image.')
    for (let offset = 12; offset + 8 <= buffer.length;) {
      const chunk = buffer.toString('ascii', offset, offset + 4), size = buffer.readUInt32LE(offset + 4), start = offset + 8
      if (start + size > buffer.length) throw new Error('Invalid WebP image.')
      if (chunk === 'ANIM' || chunk === 'ANMF') throw new Error('Animated backgrounds are not supported.')
      if (chunk === 'VP8X' && size >= 10) {
        if (buffer[start] & 2) throw new Error('Animated backgrounds are not supported.')
        width = 1 + buffer.readUIntLE(start + 4, 3); height = 1 + buffer.readUIntLE(start + 7, 3)
      } else if (chunk === 'VP8 ' && size >= 10) {
        if (buffer.toString('hex', start + 3, start + 6) !== '9d012a') throw new Error('Invalid WebP frame.')
        const w = buffer.readUInt16LE(start + 6) & 0x3fff, h = buffer.readUInt16LE(start + 8) & 0x3fff
        checkDimensions(w, h)
        if (width && (width !== w || height !== h)) throw new Error('Inconsistent WebP dimensions.')
        width = w; height = h
      } else if (chunk === 'VP8L' && size >= 5 && buffer[start] === 47) {
        const bits = buffer.readUInt32LE(start + 1), w = (bits & 0x3fff) + 1, h = ((bits >>> 14) & 0x3fff) + 1
        checkDimensions(w, h)
        if (width && (width !== w || height !== h)) throw new Error('Inconsistent WebP dimensions.')
        width = w; height = h
      }
      if (width) checkDimensions(width, height)
      offset = start + size + (size & 1)
    }
  }
  const extensions = { png: ['.png'], jpeg: ['.jpg', '.jpeg'], webp: ['.webp'] }
  if (!type || !extensions[type].includes(extension.toLowerCase())) throw new Error('Choose a PNG, JPEG or WebP image with a matching file extension.')
  checkDimensions(width, height)
  return { type, width, height }
}

async function readBounded(file) {
  const info = await fs.lstat(file)
  if (!info.isFile() || info.isSymbolicLink() || info.size > MAX_BYTES) throw new Error('Image is not a regular file under 20 MB.')
  const handle = await fs.open(file, 'r')
  try {
    const bytes = Buffer.alloc(MAX_BYTES + 1)
    let length = 0
    while (length < bytes.length) {
      const result = await handle.read(bytes, length, bytes.length - length, null)
      if (!result.bytesRead) break
      length += result.bytesRead
    }
    if (length > MAX_BYTES) throw new Error('Choose an image under 20 MB.')
    return bytes.subarray(0, length)
  } finally { await handle.close() }
}

async function importImage(file, directory) {
  const { BrowserWindow, session } = require('electron')
  if (process.platform === 'win32' && !/^[a-z]:[\\/]/iu.test(file)) throw new Error('Choose an image on a local drive.')
  const bytes = await readBounded(file)
  const header = inspectImage(bytes, path.extname(file))
  // Decode in a disposable sandbox, not the privileged main process. No preload,
  // network, Node APIs, navigation, or renderer-supplied script is available here.
  const isolated = session.fromPartition(`image-${randomBytes(16).toString('hex')}`)
  isolated.setPermissionRequestHandler((_wc, _permission, done) => done(false))
  isolated.setPermissionCheckHandler(() => false)
  isolated.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*', 'file://*/*'] }, (_details, done) => done({ cancel: true }))
  const decoder = new BrowserWindow({ show: false, width: 1, height: 1, webPreferences: { session: isolated, sandbox: true, contextIsolation: true, nodeIntegration: false, webSecurity: true, devTools: false } })
  decoder.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  decoder.webContents.on('will-navigate', event => event.preventDefault())
  let timer
  try {
    const timeout = new Promise((_, reject) => { timer = setTimeout(() => { decoder.destroy(); reject(new Error('Image decoding timed out.')) }, 15000) })
    const decoded = await Promise.race([timeout, (async () => {
      await decoder.loadURL('data:text/html,<meta http-equiv="Content-Security-Policy" content="default-src %27none%27; img-src data:;">')
      return decoder.webContents.executeJavaScript(`(async () => {
        const bytes = Uint8Array.from(atob(${JSON.stringify(bytes.toString('base64'))}), c => c.charCodeAt(0));
        const bitmap = await createImageBitmap(new Blob([bytes], { type: ${JSON.stringify(`image/${header.type}`)} }));
        if (!bitmap.width || !bitmap.height || bitmap.width * bitmap.height > ${MAX_PIXELS} || bitmap.width > 12000 || bitmap.height > 12000) { bitmap.close(); throw Error('Image dimensions exceed the limit.'); }
        const scale = Math.min(1, 2560 / bitmap.width, 1440 / bitmap.height);
        const canvas = document.createElement('canvas'); canvas.width = Math.max(1, Math.round(bitmap.width * scale)); canvas.height = Math.max(1, Math.round(bitmap.height * scale));
        canvas.getContext('2d').drawImage(bitmap, 0, 0, canvas.width, canvas.height); bitmap.close();
        return canvas.toDataURL('image/png');
      })()`)
    })()])
    if (typeof decoded !== 'string' || !decoded.startsWith('data:image/png;base64,') || decoded.length > MAX_BYTES * 1.4) throw new Error('Image could not be converted.')
    const png = Buffer.from(decoded.slice(22), 'base64')
    inspectImage(png, '.png')
    const id = randomBytes(16).toString('hex')
    await fs.mkdir(directory, { recursive: true, mode: 0o700 })
    await fs.writeFile(path.join(directory, `${id}.png`), png, { flag: 'wx', mode: 0o600 })
    return id
  } finally {
    clearTimeout(timer)
    if (!decoder.isDestroyed()) decoder.destroy()
    await isolated.clearStorageData().catch(() => {})
  }
}
module.exports = { inspectImage, readBounded, importImage }
