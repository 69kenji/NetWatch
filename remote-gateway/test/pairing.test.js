require('reflect-metadata')

const assert = require('node:assert/strict')
const crypto = require('node:crypto')
const { EventEmitter } = require('node:events')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { Readable } = require('node:stream')
const test = require('node:test')
const x509 = require('@peculiar/x509')

const { RemoteError, RemoteGateway } = require('../server')

x509.cryptoProvider.set(crypto.webcrypto)

function pem(label, data) {
  const base64 = Buffer.from(data).toString('base64').match(/.{1,64}/gu).join('\n')
  return `-----BEGIN ${label}-----\n${base64}\n-----END ${label}-----\n`
}

async function testIdentity() {
  const algorithm = { name: 'ECDSA', namedCurve: 'P-256', hash: 'SHA-256' }
  const keys = await crypto.webcrypto.subtle.generateKey(algorithm, true, ['sign', 'verify'])
  const certificate = await x509.X509CertificateGenerator.createSelfSigned({
    serialNumber: '01',
    name: 'CN=NetWatch Test',
    notBefore: new Date(Date.now() - 60_000),
    notAfter: new Date(Date.now() + 60_000),
    signingAlgorithm: algorithm,
    keys,
  })
  return {
    cert: certificate.toString('pem'),
    key: pem('PRIVATE KEY', await crypto.webcrypto.subtle.exportKey('pkcs8', keys.privateKey)),
  }
}

function jsonRequest(value, authorization = null) {
  const raw = Buffer.from(JSON.stringify(value))
  const request = Readable.from([raw])
  request.headers = { 'content-type': 'application/json', 'content-length': String(raw.length) }
  if (authorization) request.headers.authorization = authorization
  return request
}

function gatewayRequest({ host = '192.168.60.10:42117', authorization = null } = {}) {
  const request = Readable.from([])
  request.method = 'GET'
  request.url = '/remote/v1/status'
  request.headers = { host }
  if (authorization) request.headers.authorization = authorization
  request.socket = { remoteAddress: '192.168.60.20' }
  return request
}

class FakeResponse extends EventEmitter {
  constructor() {
    super()
    this.headersSent = false
    this.destroyed = false
    this.body = Buffer.alloc(0)
  }
  writeHead(status, headers) {
    this.statusCode = status
    this.headers = headers
    this.headersSent = true
  }
  end(payload = Buffer.alloc(0)) {
    this.body = Buffer.from(payload)
    this.emit('close')
  }
  destroy() {
    this.destroyed = true
    this.emit('close')
  }
}

test('pairing claim is one-time, credentials authenticate, and revocation is immediate', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'netwatch-pairing-'))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const tls = await testIdentity()
  const gateway = new RemoteGateway({
    host: '192.168.50.10',
    netmask: '255.255.255.0',
    port: 42117,
    tls,
    devicesPath: path.join(directory, 'devices.json'),
    serverSpkiSha256: 'x'.repeat(43),
  })
  t.after(() => gateway.stop())

  const pairing = gateway.beginPairing()
  const response = new FakeResponse()
  await gateway.claimPairing(jsonRequest({ pairing_secret: pairing.pairing_secret, device_name: 'Pixel 10' }), response, '192.168.50.20')
  assert.equal(response.statusCode, 201)
  const issued = JSON.parse(response.body.toString('utf8'))
  assert.match(issued.device_credential, /^[A-Za-z0-9_-]{43}$/u)
  assert.equal(gateway.authenticate({ headers: { authorization: `Bearer ${issued.device_credential}` } }).name, 'Pixel 10')

  await assert.rejects(
    gateway.claimPairing(jsonRequest({ pairing_secret: pairing.pairing_secret, device_name: 'Replay' }), new FakeResponse(), '192.168.50.20'),
    error => error instanceof RemoteError && error.code === 'PAIRING_EXPIRED',
  )
  gateway.revokeDevice(issued.device_id)
  assert.throws(
    () => gateway.authenticate({ headers: { authorization: `Bearer ${issued.device_credential}` } }),
    error => error instanceof RemoteError && error.code === 'AUTH_REQUIRED',
  )
})

test('pairing rejects invalid device names without consuming the secret', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'netwatch-pairing-name-'))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const gateway = new RemoteGateway({
    host: '10.20.30.40',
    netmask: '255.255.255.0',
    tls: await testIdentity(),
    devicesPath: path.join(directory, 'devices.json'),
  })
  t.after(() => gateway.stop())
  const pairing = gateway.beginPairing()
  await assert.rejects(
    gateway.claimPairing(jsonRequest({ pairing_secret: pairing.pairing_secret, device_name: '' }), new FakeResponse(), '10.20.30.50'),
    error => error instanceof RemoteError && error.status === 422,
  )
  assert.equal(gateway.pairing.secret, pairing.pairing_secret)
})

test('gateway rejects mismatched hosts and rate limits repeated authentication failures', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'netwatch-request-boundary-'))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const gateway = new RemoteGateway({
    host: '192.168.60.10',
    netmask: '255.255.255.0',
    port: 42117,
    tls: await testIdentity(),
    devicesPath: path.join(directory, 'devices.json'),
  })
  t.after(() => gateway.stop())

  const wrongHost = new FakeResponse()
  await gateway.handle(gatewayRequest({ host: 'attacker.invalid' }), wrongHost)
  assert.equal(wrongHost.statusCode, 421)
  assert.equal(JSON.parse(wrongHost.body.toString('utf8')).error.code, 'INVALID_HOST')

  for (let attempt = 0; attempt < 30; attempt += 1) {
    const response = new FakeResponse()
    await gateway.handle(gatewayRequest(), response)
    assert.equal(response.statusCode, 401)
  }
  const limited = new FakeResponse()
  await gateway.handle(gatewayRequest(), limited)
  assert.equal(limited.statusCode, 429)
  assert.equal(JSON.parse(limited.body.toString('utf8')).error.code, 'RATE_LIMITED')
})
