const crypto = require('crypto')
const net = require('net')

const FORBIDDEN_RESPONSE_KEYS = new Set([
  '__proto__',
  'apikey',
  'api_key',
  'x-api-key',
  'magnet',
  'source_url',
  'save_path',
  'content_path',
  'constructor',
  'download_ref',
  'hash',
  'info_hash',
  'path',
  'source_type',
  'torrent_hash',
  'url',
  'wireguard',
  'private_key',
  'prototype',
])

function normalizeIpv4(value) {
  const candidate = String(value || '').trim()
  if (candidate.startsWith('::ffff:')) return candidate.slice(7)
  return candidate
}

function ipv4ToInt(value) {
  const normalized = normalizeIpv4(value)
  if (net.isIP(normalized) !== 4) return null
  return normalized.split('.').reduce((result, part) => ((result << 8) | Number(part)) >>> 0, 0)
}

function isPrivateIpv4(value) {
  const number = ipv4ToInt(value)
  if (number === null) return false
  return (
    ((number & 0xff000000) >>> 0) === 0x0a000000 ||
    ((number & 0xfff00000) >>> 0) === 0xac100000 ||
    ((number & 0xffff0000) >>> 0) === 0xc0a80000
  )
}

function isSameSubnet(address, peer, netmask) {
  const addressNumber = ipv4ToInt(address)
  const peerNumber = ipv4ToInt(peer)
  const maskNumber = ipv4ToInt(netmask)
  if (addressNumber === null || peerNumber === null || maskNumber === null) return false
  return (addressNumber & maskNumber) === (peerNumber & maskNumber)
}

function timingSafeTextEqual(left, right) {
  const leftBuffer = Buffer.from(String(left || ''), 'utf8')
  const rightBuffer = Buffer.from(String(right || ''), 'utf8')
  if (leftBuffer.length !== rightBuffer.length) {
    const dummy = Buffer.alloc(Math.max(leftBuffer.length, rightBuffer.length, 1))
    crypto.timingSafeEqual(dummy, dummy)
    return false
  }
  return crypto.timingSafeEqual(leftBuffer, rightBuffer)
}

function sha256Base64Url(value) {
  return crypto.createHash('sha256').update(String(value || ''), 'utf8').digest('base64url')
}

function sanitizeRemotePayload(value, depth = 0) {
  if (depth > 16) throw new Error('Backend response nesting exceeds the remote limit')
  if (Array.isArray(value)) return value.map(item => sanitizeRemotePayload(item, depth + 1))
  if (!value || typeof value !== 'object') return value

  const result = {}
  for (const [rawKey, rawValue] of Object.entries(value)) {
    const key = String(rawKey)
    if (FORBIDDEN_RESPONSE_KEYS.has(key.toLowerCase())) continue
    result[key] = sanitizeRemotePayload(rawValue, depth + 1)
  }
  return result
}

function assertSafeResponse(value) {
  const serialized = JSON.stringify(value).toLowerCase()
  const forbiddenFragments = [
    'x-api-key',
    'api_key',
    'apikey=',
    'wireguard',
    'magnet:?',
    'file://',
    'http://',
    'https://',
    '\\\\',
    ':\\\\',
    '127.0.0.1:8000',
    '127.0.0.1:8081',
    '127.0.0.1:9696',
  ]
  if (forbiddenFragments.some(fragment => serialized.includes(fragment))) {
    throw new Error('Backend response failed the remote data-minimization policy')
  }
}

function normalizeDeviceName(value) {
  const candidate = String(value || '').trim().replace(/[\u0000-\u001f\u007f]/gu, '')
  if (!candidate || candidate.length > 80) throw new Error('Device name must be 1-80 characters')
  return candidate
}

function parseCatalogId(value) {
  const match = /^(movie|tv):(\d{1,9})$/u.exec(String(value || ''))
  if (!match) throw new Error('Catalog ID is invalid')
  const id = Number(match[2])
  if (!Number.isSafeInteger(id) || id < 1) throw new Error('Catalog ID is invalid')
  return { kind: match[1], id }
}

function pairingRendererPayload(payload, qrDataUrl) {
  return {
    version: payload.version,
    host: payload.host,
    port: payload.port,
    expires_at: payload.expires_at,
    server_spki_sha256: payload.server_spki_sha256,
    qr_data_url: qrDataUrl,
  }
}

module.exports = {
  assertSafeResponse,
  isPrivateIpv4,
  isSameSubnet,
  normalizeDeviceName,
  normalizeIpv4,
  pairingRendererPayload,
  parseCatalogId,
  sanitizeRemotePayload,
  sha256Base64Url,
  timingSafeTextEqual,
}
