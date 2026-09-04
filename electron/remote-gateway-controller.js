require('reflect-metadata')

const crypto = require('crypto')
const fs = require('fs')
const os = require('os')
const path = require('path')
const QRCode = require('qrcode')
const x509 = require('@peculiar/x509')
const { app, safeStorage, utilityProcess } = require('electron')

const { DEFAULT_PORT } = require('../remote-gateway/server')
const { isPrivateIpv4, pairingRendererPayload } = require('../remote-gateway/security')

x509.cryptoProvider.set(crypto.webcrypto)

const SETTINGS_VERSION = 1
const IDENTITY_VERSION = 1

function privateInterfaces() {
  const result = []
  for (const [name, addresses] of Object.entries(os.networkInterfaces())) {
    for (const item of addresses || []) {
      const family = typeof item.family === 'string' ? item.family : item.family === 4 ? 'IPv4' : String(item.family)
      if (family !== 'IPv4' || item.internal || !isPrivateIpv4(item.address)) continue
      result.push({
        id: `${name}:${item.address}`,
        name,
        address: item.address,
        netmask: item.netmask,
        cidr: item.cidr || null,
      })
    }
  }
  return result.sort((left, right) => left.name.localeCompare(right.name) || left.address.localeCompare(right.address))
}

function pem(label, data) {
  const base64 = Buffer.from(data).toString('base64').match(/.{1,64}/gu)?.join('\n') || ''
  return `-----BEGIN ${label}-----\n${base64}\n-----END ${label}-----\n`
}

function atomicJson(filePath, value) {
  const directory = path.dirname(filePath)
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 })
  const temporary = `${filePath}.${process.pid}.${Date.now()}.tmp`
  fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', mode: 0o600, flag: 'wx' })
  fs.renameSync(temporary, filePath)
}

async function createIdentity() {
  if (!safeStorage.isEncryptionAvailable()) {
    throw new Error('Windows-bound secure storage is unavailable; Remote Access remains disabled')
  }
  const algorithm = {
    name: 'ECDSA',
    namedCurve: 'P-256',
    hash: 'SHA-256',
  }
  const keys = await crypto.webcrypto.subtle.generateKey(algorithm, true, ['sign', 'verify'])
  const now = Date.now()
  const certificate = await x509.X509CertificateGenerator.createSelfSigned({
    serialNumber: crypto.randomBytes(16).toString('hex'),
    name: 'CN=NetWatch Remote Gateway',
    notBefore: new Date(now - 24 * 60 * 60 * 1000),
    notAfter: new Date(now + 10 * 365 * 24 * 60 * 60 * 1000),
    signingAlgorithm: algorithm,
    keys,
    extensions: [
      new x509.BasicConstraintsExtension(false, undefined, true),
      new x509.KeyUsagesExtension(x509.KeyUsageFlags.digitalSignature, true),
      new x509.ExtendedKeyUsageExtension(['1.3.6.1.5.5.7.3.1'], true),
      await x509.SubjectKeyIdentifierExtension.create(keys.publicKey),
    ],
  })
  const certificatePem = certificate.toString('pem')
  const privateDer = await crypto.webcrypto.subtle.exportKey('pkcs8', keys.privateKey)
  const privatePem = pem('PRIVATE KEY', privateDer)
  const parsed = new crypto.X509Certificate(certificatePem)
  const spki = parsed.publicKey.export({ type: 'spki', format: 'der' })
  return {
    version: IDENTITY_VERSION,
    certificate_pem: certificatePem,
    encrypted_private_key: safeStorage.encryptString(privatePem).toString('base64'),
    spki_sha256: crypto.createHash('sha256').update(spki).digest('base64url'),
    created_at: new Date().toISOString(),
  }
}

class RemoteGatewayController {
  constructor({ getRuntimeReady, isTorrentInDesktopUse, onStatus }) {
    this.getRuntimeReady = getRuntimeReady
    this.isTorrentInDesktopUse = isTorrentInDesktopUse
    this.onStatus = onStatus
    this.directory = path.join(app.getPath('userData'), 'remote-gateway')
    this.settingsPath = path.join(this.directory, 'settings.json')
    this.identityPath = path.join(this.directory, 'identity.json')
    this.devicesPath = path.join(this.directory, 'devices.json')
    this.settings = this.loadSettings()
    this.child = null
    this.sequence = 0
    this.pending = new Map()
    this.lastStatus = { enabled: false, error: null, paired_devices: [] }
  }

  loadSettings() {
    try {
      const value = JSON.parse(fs.readFileSync(this.settingsPath, 'utf8'))
      if (value?.version !== SETTINGS_VERSION) return { version: SETTINGS_VERSION, enabled: false, host: null, port: DEFAULT_PORT }
      return {
        version: SETTINGS_VERSION,
        enabled: Boolean(value.enabled),
        host: typeof value.host === 'string' ? value.host : null,
        port: Number.isInteger(value.port) && value.port >= 1024 && value.port <= 65535 ? value.port : DEFAULT_PORT,
      }
    } catch (error) {
      if (error?.code !== 'ENOENT') console.warn('[RemoteAccess] Settings are unreadable; feature remains disabled.')
      return { version: SETTINGS_VERSION, enabled: false, host: null, port: DEFAULT_PORT }
    }
  }

  saveSettings() {
    atomicJson(this.settingsPath, this.settings)
  }

  async ensureIdentity() {
    try {
      const identity = JSON.parse(fs.readFileSync(this.identityPath, 'utf8'))
      if (identity?.version !== IDENTITY_VERSION || !identity.certificate_pem || !identity.encrypted_private_key || !identity.spki_sha256) {
        throw new Error('invalid identity')
      }
      return identity
    } catch (error) {
      if (error?.code !== 'ENOENT' && error?.message !== 'invalid identity') {
        throw new Error('Remote identity is malformed; regenerate it explicitly from Settings')
      }
      const identity = await createIdentity()
      atomicJson(this.identityPath, identity)
      return identity
    }
  }

  publicStatus() {
    let pairedDevices = this.lastStatus.paired_devices || []
    if (!this.child) {
      try {
        const { DeviceStore } = require('../remote-gateway/state-store')
        pairedDevices = new DeviceStore(this.devicesPath).listPublic()
      } catch {
        pairedDevices = []
      }
    }
    return {
      ...this.lastStatus,
      paired_devices: pairedDevices,
      configured_enabled: this.settings.enabled,
      selected_host: this.settings.host,
      selected_port: this.settings.port,
      interfaces: privateInterfaces(),
    }
  }

  emitStatus() {
    this.onStatus?.(this.publicStatus())
  }

  async initialize() {
    if (!this.settings.enabled) {
      this.emitStatus()
      return this.publicStatus()
    }
    try {
      await this.startChild()
    } catch (error) {
      this.lastStatus = { enabled: false, error: error instanceof Error ? error.message : String(error), paired_devices: [] }
      this.emitStatus()
    }
    return this.publicStatus()
  }

  async enable({ host, port = DEFAULT_PORT }) {
    const selected = privateInterfaces().find(item => item.address === host)
    if (!selected) throw new Error('Select an active private IPv4 interface')
    const normalizedPort = Number(port)
    if (!Number.isInteger(normalizedPort) || normalizedPort < 1024 || normalizedPort > 65535) {
      throw new Error('Remote Access port must be between 1024 and 65535')
    }
    this.settings = { version: SETTINGS_VERSION, enabled: true, host: selected.address, port: normalizedPort }
    this.saveSettings()
    await this.startChild()
    return this.publicStatus()
  }

  async disable() {
    this.settings.enabled = false
    this.saveSettings()
    await this.stopChild()
    this.lastStatus = { enabled: false, error: null, paired_devices: [] }
    this.emitStatus()
    return this.publicStatus()
  }

  async startChild() {
    const selected = privateInterfaces().find(item => item.address === this.settings.host)
    if (!selected) throw new Error('The selected private IPv4 interface is unavailable')
    await this.stopChild()
    const identity = await this.ensureIdentity()
    let privateKey
    try {
      privateKey = safeStorage.decryptString(Buffer.from(identity.encrypted_private_key, 'base64'))
    } catch {
      throw new Error('Remote identity could not be unlocked for this Windows user')
    }
    const child = utilityProcess.fork(path.join(__dirname, '../remote-gateway/child.js'), [], {
      serviceName: 'NetWatch Remote Gateway',
      stdio: 'pipe',
    })
    this.child = child
    child.on('message', message => this.onChildMessage(message))
    child.on('exit', code => {
      if (this.child !== child) return
      this.child = null
      for (const request of this.pending.values()) {
        clearTimeout(request.timer)
        request.reject(new Error('Remote gateway process exited'))
      }
      this.pending.clear()
      this.lastStatus = { ...this.lastStatus, enabled: false, error: code === 0 ? null : 'Remote gateway process exited unexpectedly' }
      this.emitStatus()
    })
    child.stderr?.on('data', chunk => console.warn('[RemoteAccess]', String(chunk).trim().slice(0, 500)))
    try {
      const status = await this.request('start', {
        host: selected.address,
        netmask: selected.netmask,
        port: this.settings.port,
        desktopVersion: app.getVersion(),
        runtimeReady: Boolean(this.getRuntimeReady?.()),
        backendBaseUrl: 'http://127.0.0.1:8000',
        devicesPath: this.devicesPath,
        serverSpkiSha256: identity.spki_sha256,
        tls: { key: privateKey, cert: identity.certificate_pem },
      }, 15_000)
      privateKey = ''
      this.lastStatus = { ...status, error: null }
      this.emitStatus()
      return status
    } catch (error) {
      privateKey = ''
      await this.stopChild()
      throw error
    }
  }

  onChildMessage(message) {
    if (message?.type === 'response') {
      const pending = this.pending.get(message.id)
      if (!pending) return
      this.pending.delete(message.id)
      clearTimeout(pending.timer)
      if (message.error) pending.reject(new Error(message.error))
      else pending.resolve(message.result)
      return
    }
    if (message?.type === 'cleanup-query') {
      const allowed = !this.isTorrentInDesktopUse?.(message.infoHash)
      this.child?.postMessage({ type: 'cleanup-response', id: message.id, allowed })
      return
    }
    if (message?.type === 'event' && message.event?.type === 'status') {
      this.lastStatus = { ...message.event.status, error: null }
      this.emitStatus()
    }
  }

  request(action, payload = null, timeoutMs = 10_000) {
    if (!this.child) return Promise.reject(new Error('Remote gateway is disabled'))
    const id = `remote-${++this.sequence}`
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error('Remote gateway action timed out'))
      }, timeoutMs)
      this.pending.set(id, { resolve, reject, timer })
      this.child.postMessage({ type: 'request', id, action, payload })
    })
  }

  async stopChild() {
    const child = this.child
    if (!child) return
    try {
      await this.request('stop', null, 10_000)
    } catch { /* process termination below is the fallback */ }
    if (this.child === child) {
      this.child = null
      child.kill()
    }
  }

  async setRuntimeReady(ready) {
    if (!this.child) return
    try {
      const status = await this.request('runtime-ready', { ready })
      this.lastStatus = { ...status, error: null }
      this.emitStatus()
    } catch { /* startup/quit races do not weaken the backend kill switch */ }
  }

  async beginPairing() {
    const payload = await this.request('begin-pairing')
    const encoded = JSON.stringify(payload)
    const qrDataUrl = await QRCode.toDataURL(encoded, { errorCorrectionLevel: 'M', margin: 1, width: 320 })
    return pairingRendererPayload(payload, qrDataUrl)
  }

  async cancelPairing() {
    await this.request('cancel-pairing')
    return this.publicStatus()
  }

  async revokeDevice(deviceId) {
    if (!/^[0-9a-f-]{36}$/iu.test(String(deviceId || ''))) throw new Error('Device identifier is invalid')
    if (this.child) {
      await this.request('revoke-device', { deviceId })
    } else {
      const { DeviceStore } = require('../remote-gateway/state-store')
      new DeviceStore(this.devicesPath).revoke(deviceId)
      this.emitStatus()
    }
    return this.publicStatus()
  }

  async revokeAll() {
    if (this.child) {
      await this.request('revoke-all')
    } else {
      const { DeviceStore } = require('../remote-gateway/state-store')
      new DeviceStore(this.devicesPath).revokeAll()
      this.emitStatus()
    }
    return this.publicStatus()
  }

  async regenerateIdentity() {
    const wasEnabled = this.settings.enabled
    await this.stopChild()
    // Generate before replacing the old encrypted identity so a secure-storage
    // failure cannot leave the user with neither the old nor the new key.
    const identity = await createIdentity()
    atomicJson(this.identityPath, identity)
    // A changed pin invalidates every existing device credential as one atomic
    // recovery action. Keep the revoked records for audit/UI history.
    const store = require('../remote-gateway/state-store')
    const devices = new store.DeviceStore(this.devicesPath)
    devices.revokeAll()
    if (wasEnabled) await this.startChild()
    return this.publicStatus()
  }
}

module.exports = { RemoteGatewayController, createIdentity, privateInterfaces }
