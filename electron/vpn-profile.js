'use strict'

const VPN_PROFILE_TYPES = Object.freeze({
  GENERIC: 'generic',
  VPNBOOK: 'vpnbook',
})

const VPNBOOK_REFRESH_URL = 'https://www.vpnbook.com/freevpn/wireguard-vpn'
const MIN_PLAUSIBLE_FILE_TIME_MS = Date.UTC(2000, 0, 1)
const FUTURE_FILE_TIME_TOLERANCE_MS = 5 * 60 * 1000

function normalizeVpnProfileType(value) {
  return value === VPN_PROFILE_TYPES.VPNBOOK ? VPN_PROFILE_TYPES.VPNBOOK : VPN_PROFILE_TYPES.GENERIC
}

function isoFromPlausibleMs(value, nowMs = Date.now()) {
  if (!Number.isFinite(value)) return ''
  if (value < MIN_PLAUSIBLE_FILE_TIME_MS) return ''
  if (value > nowMs + FUTURE_FILE_TIME_TOLERANCE_MS) return ''
  try {
    return new Date(value).toISOString()
  } catch (_) {
    return ''
  }
}

function wireGuardFileTimestamps(stat, nowMs = Date.now()) {
  return {
    sourceCreatedAt: isoFromPlausibleMs(stat?.birthtimeMs, nowMs),
    sourceModifiedAt: isoFromPlausibleMs(stat?.mtimeMs, nowMs),
  }
}

module.exports = {
  VPN_PROFILE_TYPES,
  VPNBOOK_REFRESH_URL,
  normalizeVpnProfileType,
  wireGuardFileTimestamps,
}
