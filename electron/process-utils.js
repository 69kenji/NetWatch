'use strict'

const { spawn } = require('child_process')

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

async function httpOk(url, timeoutMs = 1500) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const response = await fetch(url, { signal: controller.signal, cache: 'no-store' })
    return response.ok
  } catch (_) {
    return false
  } finally {
    clearTimeout(timer)
  }
}

async function waitForHttp(url, timeoutMs, pollMs = 400) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await httpOk(url)) return true
    await sleep(pollMs)
  }
  return false
}

function runProcess(command, args, {
  timeoutMs = 30_000,
  cwd = undefined,
  env = process.env,
  input = null,
  rejectOnNonzero = true,
  maxOutputBytes = 256 * 1024,
} = {}) {
  return new Promise((resolve, reject) => {
    const hasInput = Buffer.isBuffer(input) || typeof input === 'string'
    const child = spawn(command, args, {
      shell: false,
      windowsHide: true,
      cwd,
      env,
      stdio: [hasInput ? 'pipe' : 'ignore', 'pipe', 'pipe'],
    })

    let stdout = ''
    let stderr = ''
    let settled = false
    const appendBounded = (current, chunk) => `${current}${chunk.toString()}`.slice(-maxOutputBytes)
    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      child.kill()
      reject(new Error(`${command} timed out after ${timeoutMs}ms`))
    }, timeoutMs)

    child.stdout.on('data', chunk => { stdout = appendBounded(stdout, chunk) })
    child.stderr.on('data', chunk => { stderr = appendBounded(stderr, chunk) })
    child.once('error', error => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      reject(error)
    })
    child.once('exit', code => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (code === 0 || !rejectOnNonzero) {
        resolve({ stdout, stderr, code })
      } else {
        reject(new Error(`${command} exited with code ${code}: ${(stderr || stdout).trim()}`))
      }
    })

    if (hasInput) {
      child.stdin.on('error', () => {})
      child.stdin.end(input)
    }
  })
}

function cleanWslOutput(value) {
  return String(value || '').replace(/\0/gu, '').replace(/\r/gu, '').trim()
}

module.exports = { cleanWslOutput, httpOk, runProcess, sleep, waitForHttp }
