'use strict'

const crypto = require('crypto')
const fs = require('fs')
const { atomicJson } = require('./app-settings-store')

const TOKEN_PATTERN = /^[0-9a-f]{48}$/u

function loadPlaybackOwnerToken(filePath, randomBytes = crypto.randomBytes) {
  try {
    if (fs.statSync(filePath).size > 1024) throw new Error('owner token file is too large')
    const value = JSON.parse(fs.readFileSync(filePath, 'utf8'))
    if (value?.version === 1 && TOKEN_PATTERN.test(value.token)) return value.token
    throw new Error('owner token file is invalid')
  } catch (error) {
    if (error?.code !== 'ENOENT') console.warn('[Player] Playback owner token was replaced:', error?.message || error)
  }

  const token = randomBytes(24).toString('hex')
  if (!TOKEN_PATTERN.test(token)) throw new Error('Could not create a playback owner token')
  atomicJson(filePath, { version: 1, token })
  return token
}

module.exports = { loadPlaybackOwnerToken }
