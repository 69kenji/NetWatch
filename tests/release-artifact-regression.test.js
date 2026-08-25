const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { execFileSync } = require('node:child_process')

const root = path.resolve(__dirname, '..')

test('checksum writer records only the archive basename, never the build path', () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'netwatch-sha-'))
  try {
    const nested = path.join(temp, 'private', 'build', 'netwatch-1.0.6.zip')
    fs.mkdirSync(path.dirname(nested), { recursive: true })
    fs.writeFileSync(nested, 'fixture')
    execFileSync(process.execPath, [path.join(root, 'packaging/write-sha256.js'), nested], { stdio: 'ignore' })
    const line = fs.readFileSync(`${nested}.sha256`, 'utf8').trim()
    assert.match(line, /^[a-f0-9]{64}  netwatch-1\.0\.6\.zip$/)
    assert.doesNotMatch(line, /[\\/](?:mnt|tmp|Users|home)[\\/]/i)
    assert.doesNotMatch(line, /[A-Za-z]:[\\/]/)
  } finally {
    fs.rmSync(temp, { recursive: true, force: true })
  }
})
