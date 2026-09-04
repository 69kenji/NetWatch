const assert = require('node:assert/strict')
const { EventEmitter } = require('node:events')
const http = require('node:http')
const { PassThrough } = require('node:stream')
const test = require('node:test')

const { BackendClient } = require('../backend-client')

class RemoteResponse extends PassThrough {
  writeHead(statusCode, headers) {
    this.statusCode = statusCode
    this.headers = headers
  }
}

test('backend client rejects path traversal before issuing a loopback request', async () => {
  const client = new BackendClient('http://127.0.0.1:65535')
  for (const pathname of [
    '/api/../admin',
    '/api/%2e%2e/admin',
    '/api/%2E%2E%2Fadmin',
    '/api\\..\\admin',
    'http://127.0.0.1:8000/api/health',
  ]) {
    await assert.rejects(client.json('GET', pathname), /approved API surface/u)
  }
})

test('media proxy forwards only the byte range and preserves range response headers', async t => {
  let observedHeaders
  const server = http.createServer((request, response) => {
    observedHeaders = request.headers
    response.writeHead(206, {
      'content-type': 'video/x-matroska',
      'content-length': '4',
      'content-range': 'bytes 4-7/12',
      'accept-ranges': 'bytes',
      'x-netwatch-piece-gated': 'true',
      'x-internal-secret': 'must-not-cross',
    })
    response.end('DATA')
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(() => server.close())
  const port = server.address().port
  const client = new BackendClient(`http://127.0.0.1:${port}`)
  const remoteRequest = new EventEmitter()
  remoteRequest.method = 'GET'
  remoteRequest.headers = { range: 'bytes=4-7', authorization: 'Bearer must-not-forward' }
  remoteRequest.complete = true
  const remoteResponse = new RemoteResponse()
  const chunks = []
  remoteResponse.on('data', chunk => chunks.push(chunk))

  await new Promise((resolve, reject) => {
    client.stream('a'.repeat(40), remoteRequest, remoteResponse, { onClosed: resolve })
    remoteResponse.on('error', reject)
  })

  assert.equal(observedHeaders.range, 'bytes=4-7')
  assert.equal(observedHeaders.authorization, undefined)
  assert.equal(remoteResponse.statusCode, 206)
  assert.equal(remoteResponse.headers['content-range'], 'bytes 4-7/12')
  assert.equal(remoteResponse.headers['x-internal-secret'], undefined)
  assert.equal(Buffer.concat(chunks).toString('utf8'), 'DATA')
})
