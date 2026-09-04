const assert = require('node:assert/strict')
const test = require('node:test')

const {
  assertSafeResponse,
  isPrivateIpv4,
  isSameSubnet,
  normalizeIpv4,
  pairingRendererPayload,
  parseCatalogId,
  sanitizeRemotePayload,
  timingSafeTextEqual,
} = require('../security')
const { transformBackendPayload } = require('../server')

test('private IPv4 and subnet policy rejects public, loopback, and link-local addresses', () => {
  assert.equal(isPrivateIpv4('10.0.0.1'), true)
  assert.equal(isPrivateIpv4('172.31.255.254'), true)
  assert.equal(isPrivateIpv4('192.168.4.10'), true)
  assert.equal(isPrivateIpv4('172.32.0.1'), false)
  assert.equal(isPrivateIpv4('127.0.0.1'), false)
  assert.equal(isPrivateIpv4('169.254.1.1'), false)
  assert.equal(isPrivateIpv4('8.8.8.8'), false)
  assert.equal(normalizeIpv4('::ffff:192.168.4.2'), '192.168.4.2')
  assert.equal(isSameSubnet('192.168.4.10', '192.168.4.200', '255.255.255.0'), true)
  assert.equal(isSameSubnet('192.168.4.10', '192.168.5.2', '255.255.255.0'), false)
})

test('remote payload removes internal transport and filesystem data recursively', () => {
  const safe = transformBackendPayload({
    title: 'Example',
    nested: {
      magnet: 'magnet:?xt=urn:btih:secret',
      path: 'C:\\secret\\video.mkv',
      api_key: 'secret',
      info_hash: 'a'.repeat(40),
      download_ref: 'provider-secret-reference',
      poster: 'http://127.0.0.1:8000/api/metadata/image/w500/poster.jpg',
      homepage: 'https://provider.example/title',
    },
  })
  assert.deepEqual(safe, {
    title: 'Example',
    nested: { poster: '/remote/v1/artwork/w500/poster.jpg', homepage: null },
  })
  assert.doesNotThrow(() => assertSafeResponse(safe))
  assert.throws(() => assertSafeResponse({ url: 'file:///C:/private.mkv' }))
  assert.throws(() => assertSafeResponse({ website: 'https://provider.example/private' }))
  assert.deepEqual(sanitizeRemotePayload([{ save_path: '/tmp', value: 2 }]), [{ value: 2 }])
})

test('remote payload sanitization drops prototype-pollution keys', () => {
  const payload = JSON.parse('{"safe":1,"__proto__":{"polluted":true},"constructor":{"prototype":{"polluted":true}}}')
  assert.deepEqual(sanitizeRemotePayload(payload), { safe: 1 })
  assert.equal({}.polluted, undefined)
})

test('credential comparisons and catalog IDs are strict', () => {
  assert.equal(timingSafeTextEqual('abc', 'abc'), true)
  assert.equal(timingSafeTextEqual('abc', 'abcd'), false)
  assert.deepEqual(parseCatalogId('movie:123'), { kind: 'movie', id: 123 })
  assert.deepEqual(parseCatalogId('tv:9'), { kind: 'tv', id: 9 })
  assert.throws(() => parseCatalogId('movie:0'))
  assert.throws(() => parseCatalogId('../movie:12'))
})

test('renderer pairing payload omits the plaintext one-time secret', () => {
  const safe = pairingRendererPayload({
    version: 1,
    host: '192.168.1.10',
    port: 42117,
    pairing_secret: 'secret-must-not-cross',
    server_spki_sha256: 'pin',
    expires_at: 'soon',
  }, 'data:image/png;base64,qr')
  assert.equal(Object.hasOwn(safe, 'pairing_secret'), false)
  assert.deepEqual(Object.keys(safe).sort(), [
    'expires_at', 'host', 'port', 'qr_data_url', 'server_spki_sha256', 'version',
  ])
})
