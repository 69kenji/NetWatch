'use strict'

const crypto = require('node:crypto')
const fs = require('node:fs')
const path = require('node:path')

const input = process.argv[2]
if (!input) {
  console.error('Usage: node packaging/write-sha256.js <archive>')
  process.exit(2)
}

const archive = path.resolve(input)
const stat = fs.statSync(archive)
if (!stat.isFile()) throw new Error('Checksum input must be a file.')

const basename = path.basename(archive)
const hash = crypto.createHash('sha256').update(fs.readFileSync(archive)).digest('hex')
const checksumPath = `${archive}.sha256`
fs.writeFileSync(checksumPath, `${hash}  ${basename}\n`, { encoding: 'utf8', mode: 0o644 })
console.log(checksumPath)
