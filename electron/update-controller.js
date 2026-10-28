'use strict'

const crypto = require('crypto')
const fs = require('fs')
const path = require('path')
const { Readable } = require('stream')
const { pipeline } = require('stream/promises')
const { app, dialog, Notification, shell } = require('electron')

const RELEASE_API = 'https://api.github.com/repos/69kenji/NetWatch/releases/latest'
const RELEASE_PAGE = 'https://github.com/69kenji/NetWatch/releases/latest'
const MAX_RELEASE_JSON = 1024 * 1024
const MAX_CHECKSUM_BYTES = 256 * 1024
const MAX_SIGNATURE_BYTES = 4096
const MAX_INSTALLER_BYTES = 1024 * 1024 * 1024
const RELEASE_PUBLIC_KEY = `-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEAeJSmuZAn8/edtCUibxLflNw2MOmt+5olDnfMBkBNXN4=
-----END PUBLIC KEY-----`

function versionParts(value) {
  const match = /^v?(\d+)\.(\d+)\.(\d+)$/u.exec(String(value || '').trim())
  return match ? match.slice(1).map(Number) : null
}

function compareVersions(left, right) {
  const a = versionParts(left), b = versionParts(right)
  if (!a || !b) return null
  for (let index = 0; index < 3; index++) if (a[index] !== b[index]) return a[index] > b[index] ? 1 : -1
  return 0
}

async function responseText(response, limit) {
  if (!response.ok) throw new Error(`Update server returned HTTP ${response.status}`)
  const declared = Number(response.headers.get('content-length'))
  if (Number.isFinite(declared) && declared > limit) throw new Error('Update response is too large')
  const text = await response.text()
  if (Buffer.byteLength(text, 'utf8') > limit) throw new Error('Update response is too large')
  return text
}

function findChecksum(text, fileName) {
  for (const line of text.split(/\r?\n/u)) {
    const match = /^([a-f0-9]{64})\s+\*?(.+)$/iu.exec(line.trim())
    if (match && path.basename(match[2]) === fileName) return match[1].toLowerCase()
  }
  const lines = text.split(/\r?\n/u).map(line => line.trim()).filter(Boolean)
  const single = lines.length === 1 ? /^([a-f0-9]{64})$/iu.exec(lines[0]) : null
  return single?.[1]?.toLowerCase() || null
}

async function hashFile(filename) {
  const hash = crypto.createHash('sha256')
  await pipeline(fs.createReadStream(filename), hash)
  return hash.digest('hex')
}

function verifyChecksumSignature(checksumText, signatureText) {
  const encoded = signatureText.trim()
  if (!/^[A-Za-z0-9+/]+={0,2}$/u.test(encoded)) return false
  const signature = Buffer.from(encoded, 'base64')
  return signature.length === 64 && crypto.verify(null, Buffer.from(checksumText, 'utf8'), RELEASE_PUBLIC_KEY, signature)
}

function trustedReleaseAsset(asset) {
  if (!asset || typeof asset.browser_download_url !== 'string') return false
  try {
    const url = new URL(asset.browser_download_url)
    return url.protocol === 'https:' && url.hostname === 'github.com' && url.pathname.startsWith('/69kenji/NetWatch/releases/download/')
  } catch {
    return false
  }
}

function createUpdateController({ appSettings, desktopShell }) {
  let currentRelease = null
  let verifiedInstaller = null
  let notificationTimer = null
  let lastNotifiedVersion = null

  const request = url => fetch(url, {
    redirect: 'follow',
    headers: { Accept: 'application/vnd.github+json', 'User-Agent': `NetWatch/${app.getVersion()}` },
    signal: AbortSignal.timeout(20_000),
  })

  const check = async ({ notify = false } = {}) => {
    const payload = JSON.parse(await responseText(await request(RELEASE_API), MAX_RELEASE_JSON))
    if (payload?.draft || payload?.prerelease) throw new Error('The release feed did not return a stable release')
    const availableVersion = String(payload?.tag_name || '').replace(/^v/u, '')
    const comparison = compareVersions(availableVersion, app.getVersion())
    if (comparison === null) throw new Error('The release version is invalid')
    const installerName = `NetWatch-Setup-${availableVersion}.exe`
    const installer = Array.isArray(payload.assets) ? payload.assets.find(asset =>
      asset?.name === installerName && trustedReleaseAsset(asset) && Number.isSafeInteger(asset.size) && asset.size > 0 && asset.size <= MAX_INSTALLER_BYTES) : null
    const checksum = Array.isArray(payload.assets) ? payload.assets.find(asset =>
      trustedReleaseAsset(asset) && (asset?.name === `${installerName}.sha256` || /^(?:sha256sums|checksums)(?:\.txt)?$/iu.test(asset?.name || ''))) : null
    const signature = checksum && Array.isArray(payload.assets) ? payload.assets.find(asset =>
      asset?.name === `${checksum.name}.sig` && trustedReleaseAsset(asset) && Number(asset.size) > 0 && Number(asset.size) <= MAX_SIGNATURE_BYTES) : null
    const release = {
      installedVersion: app.getVersion(),
      availableVersion,
      updateAvailable: comparison > 0,
      releaseName: typeof payload.name === 'string' ? payload.name.slice(0, 160) : `NetWatch ${availableVersion}`,
      releaseNotes: typeof payload.body === 'string' ? payload.body.slice(0, 8000) : '',
      publishedAt: typeof payload.published_at === 'string' ? payload.published_at : null,
      pageUrl: RELEASE_PAGE,
      downloadSize: Number.isSafeInteger(installer?.size) && installer.size > 0 ? installer.size : null,
      canDownload: Boolean(installer && checksum && signature),
      installer: installer ? { name: installer.name, url: installer.browser_download_url, size: installer.size } : null,
      checksum: checksum ? { name: checksum.name, url: checksum.browser_download_url } : null,
      signature: signature ? { name: signature.name, url: signature.browser_download_url } : null,
    }
    currentRelease = release
    verifiedInstaller = null
    if (notify && release.updateAvailable && release.availableVersion !== lastNotifiedVersion && Notification.isSupported()) {
      new Notification({ title: `NetWatch ${availableVersion} is available`, body: 'Open Settings to review the update.' }).show()
      lastNotifiedVersion = release.availableVersion
    }
    return { ...release, installer: undefined, checksum: undefined, signature: undefined }
  }

  const download = async () => {
    if (!currentRelease?.updateAvailable || !currentRelease.installer || !currentRelease.checksum || !currentRelease.signature) throw new Error('This release does not include signed update files')
    const checksumText = await responseText(await request(currentRelease.checksum.url), MAX_CHECKSUM_BYTES)
    const signatureText = await responseText(await request(currentRelease.signature.url), MAX_SIGNATURE_BYTES)
    if (!verifyChecksumSignature(checksumText, signatureText)) throw new Error('The release checksum signature is invalid')
    const expected = findChecksum(checksumText, currentRelease.installer.name)
    if (!expected) throw new Error('The release checksum is missing or invalid')
    const updatesDirectory = path.join(app.getPath('userData'), 'updates')
    fs.mkdirSync(updatesDirectory, { recursive: true, mode: 0o700 })
    const installerPath = path.join(updatesDirectory, currentRelease.installer.name)
    const response = await request(currentRelease.installer.url)
    if (!response.ok || !response.body) throw new Error(`Download failed with HTTP ${response.status}`)
    const declared = Number(response.headers.get('content-length'))
    if (Number.isFinite(declared) && (declared <= 0 || declared > MAX_INSTALLER_BYTES)) throw new Error('The installer size is invalid')
    if (currentRelease.installer.size && declared && declared !== currentRelease.installer.size) throw new Error('The installer size does not match the release')
    const temporary = `${installerPath}.${process.pid}.${crypto.randomBytes(8).toString('hex')}.download`
    const hash = crypto.createHash('sha256')
    let received = 0
    const meter = new (require('stream').Transform)({
      transform(chunk, _encoding, callback) {
        received += chunk.length
        if (received > MAX_INSTALLER_BYTES) return callback(new Error('The installer is too large'))
        hash.update(chunk)
        callback(null, chunk)
      },
    })
    try {
      await pipeline(Readable.fromWeb(response.body), meter, fs.createWriteStream(temporary, { flags: 'wx', mode: 0o600 }))
      if (currentRelease.installer.size && received !== currentRelease.installer.size) throw new Error('The installer download is incomplete')
      const actual = hash.digest('hex')
      if (actual !== expected) throw new Error('The installer failed SHA-256 verification')
      try { fs.unlinkSync(installerPath) } catch (error) { if (error?.code !== 'ENOENT') throw error }
      fs.renameSync(temporary, installerPath)
      verifiedInstaller = { path: installerPath, sha256: actual, version: currentRelease.availableVersion }
      return { cancelled: false, fileName: path.basename(installerPath), sha256: actual, version: currentRelease.availableVersion }
    } finally {
      try { fs.unlinkSync(temporary) } catch (error) { if (error?.code !== 'ENOENT') console.warn('[Update] Temporary download could not be removed.') }
    }
  }

  const openInstaller = async () => {
    if (!verifiedInstaller || !fs.existsSync(verifiedInstaller.path)) throw new Error('Download and verify the update first')
    if (await hashFile(verifiedInstaller.path) !== verifiedInstaller.sha256) {
      verifiedInstaller = null
      throw new Error('The downloaded installer changed after verification')
    }
    const result = await dialog.showMessageBox(desktopShell.getMainWindow(), {
      type: 'info',
      buttons: ['Cancel', 'Open installer'],
      defaultId: 0,
      cancelId: 0,
      title: `Install NetWatch ${verifiedInstaller.version}?`,
      message: 'NetWatch will open the verified installer. Close the app when the installer asks you to.',
    })
    if (result.response !== 1) return { cancelled: true }
    if (await hashFile(verifiedInstaller.path) !== verifiedInstaller.sha256) {
      verifiedInstaller = null
      throw new Error('The downloaded installer changed before it could be opened')
    }
    const error = await shell.openPath(verifiedInstaller.path)
    if (error) throw new Error('Windows could not open the installer')
    return { cancelled: false }
  }

  const openReleasePage = async () => { await shell.openExternal(RELEASE_PAGE); return { opened: true } }
  const startNotifications = () => {
    clearTimeout(notificationTimer)
    if (!appSettings.getGlobalSettings().updateNotifications) return
    notificationTimer = setTimeout(() => { void check({ notify: true }).catch(error => console.warn('[Update] Background check failed:', error?.message || error)) }, 15_000)
  }

  return { check, download, openInstaller, openReleasePage, startNotifications }
}

module.exports = { RELEASE_API, compareVersions, createUpdateController, findChecksum, trustedReleaseAsset, verifyChecksumSignature }
