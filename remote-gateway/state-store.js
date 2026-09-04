const fs = require('fs')
const path = require('path')
const { timingSafeTextEqual } = require('./security')

const DEVICE_SCHEMA_VERSION = 1
const MAX_DEVICES = 64

function emptyState() {
  return { version: DEVICE_SCHEMA_VERSION, devices: [] }
}

class DeviceStore {
  constructor(filePath) {
    this.filePath = path.resolve(filePath)
    this.state = emptyState()
    this.load()
  }

  load() {
    try {
      const parsed = JSON.parse(fs.readFileSync(this.filePath, 'utf8'))
      if (parsed?.version !== DEVICE_SCHEMA_VERSION || !Array.isArray(parsed.devices)) return
      this.state = {
        version: DEVICE_SCHEMA_VERSION,
        devices: parsed.devices
          .filter(item => item && typeof item.id === 'string' && typeof item.credential_hash === 'string')
          .slice(0, MAX_DEVICES)
          .map(item => ({
            id: item.id,
            name: String(item.name || 'Android device').slice(0, 80),
            credential_hash: item.credential_hash,
            paired_at: item.paired_at || null,
            last_seen: item.last_seen || null,
            revoked: Boolean(item.revoked),
          })),
      }
    } catch (error) {
      if (error?.code !== 'ENOENT') throw new Error('Remote device state is malformed or unreadable')
    }
  }

  save() {
    const directory = path.dirname(this.filePath)
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 })
    const temporary = `${this.filePath}.${process.pid}.${Date.now()}.tmp`
    fs.writeFileSync(temporary, `${JSON.stringify(this.state, null, 2)}\n`, { encoding: 'utf8', mode: 0o600, flag: 'wx' })
    fs.renameSync(temporary, this.filePath)
  }

  listPublic() {
    return this.state.devices.map(({ credential_hash: _credentialHash, ...device }) => ({ ...device }))
  }

  add(device) {
    const existing = this.state.devices.find(item => item.id === device.id)
    if (existing) throw new Error('Device identifier already exists')
    if (this.state.devices.length >= MAX_DEVICES) throw new Error('Paired device limit reached')
    this.state.devices.push({ ...device })
    this.save()
  }

  authenticate(credentialHash) {
    let matched = null
    for (const item of this.state.devices) {
      const equal = timingSafeTextEqual(item.credential_hash, credentialHash)
      if (equal && !item.revoked) matched = item
    }
    return matched
  }

  touch(deviceId) {
    const device = this.state.devices.find(item => item.id === deviceId)
    if (!device || device.revoked) return
    const now = Date.now()
    const previous = device.last_seen ? Date.parse(device.last_seen) : 0
    if (Number.isFinite(previous) && now - previous < 60_000) return
    device.last_seen = new Date(now).toISOString()
    this.save()
  }

  revoke(deviceId) {
    const device = this.state.devices.find(item => item.id === deviceId)
    if (!device) return false
    device.revoked = true
    this.save()
    return true
  }

  revokeAll() {
    let changed = false
    for (const device of this.state.devices) {
      if (!device.revoked) {
        device.revoked = true
        changed = true
      }
    }
    if (changed) this.save()
    return changed
  }
}

module.exports = { DeviceStore, DEVICE_SCHEMA_VERSION, MAX_DEVICES }
