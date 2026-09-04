const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')

const { DeviceStore } = require('../state-store')
const { sha256Base64Url } = require('../security')

test('device persistence stores only credential hashes and supports immediate revocation', t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'netwatch-device-store-'))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const filePath = path.join(directory, 'devices.json')
  const secret = 'A'.repeat(43)
  const hash = sha256Base64Url(secret)
  const device = {
    id: '106e9d7c-940a-4bb3-9f68-30e127a835a2',
    name: 'Pixel test device',
    credential_hash: hash,
    paired_at: '2026-01-01T00:00:00.000Z',
    last_seen: '2026-01-01T00:00:00.000Z',
    revoked: false,
  }

  const store = new DeviceStore(filePath)
  store.add(device)
  assert.equal(store.authenticate(hash)?.id, device.id)
  const persisted = fs.readFileSync(filePath, 'utf8')
  assert.equal(persisted.includes(secret), false)
  assert.equal(persisted.includes(hash), true)
  assert.equal(store.listPublic()[0].credential_hash, undefined)

  assert.equal(store.revoke(device.id), true)
  assert.equal(store.authenticate(hash), null)
  assert.equal(new DeviceStore(filePath).listPublic()[0].revoked, true)
})

test('malformed device state fails closed', t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'netwatch-device-store-bad-'))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const filePath = path.join(directory, 'devices.json')
  fs.writeFileSync(filePath, '{not-json')
  assert.throws(() => new DeviceStore(filePath), /malformed or unreadable/u)
})
