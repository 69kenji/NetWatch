const { parentPort } = process
const { RemoteGateway } = require('./server')

if (!parentPort) throw new Error('Remote gateway must run as an Electron utility process')

let gateway = null
let cleanupSequence = 0
const cleanupRequests = new Map()

function post(message) {
  parentPort.postMessage(message)
}

function requestCleanupApproval(infoHash) {
  return new Promise(resolve => {
    const id = `cleanup-${++cleanupSequence}`
    const timer = setTimeout(() => {
      cleanupRequests.delete(id)
      resolve(false)
    }, 5_000)
    cleanupRequests.set(id, allowed => {
      clearTimeout(timer)
      resolve(Boolean(allowed))
    })
    post({ type: 'cleanup-query', id, infoHash })
  })
}

async function action(name, payload) {
  switch (name) {
    case 'start':
      if (gateway) await gateway.stop()
      gateway = new RemoteGateway({
        ...payload,
        canCleanupTorrent: requestCleanupApproval,
        onEvent: event => post({ type: 'event', event }),
      })
      return gateway.start()
    case 'stop':
      if (gateway) await gateway.stop()
      gateway = null
      return { enabled: false }
    case 'status':
      return gateway?.status() || { enabled: false }
    case 'runtime-ready':
      gateway?.setRuntimeReady(Boolean(payload?.ready))
      return gateway?.status() || { enabled: false }
    case 'begin-pairing':
      if (!gateway) throw new Error('Remote gateway is disabled')
      return gateway.beginPairing()
    case 'cancel-pairing':
      if (!gateway) throw new Error('Remote gateway is disabled')
      return gateway.cancelPairing()
    case 'revoke-device':
      if (!gateway) throw new Error('Remote gateway is disabled')
      return { revoked: gateway.revokeDevice(String(payload?.deviceId || '')) }
    case 'revoke-all':
      if (!gateway) throw new Error('Remote gateway is disabled')
      return { revoked: gateway.revokeAll() }
    default:
      throw new Error('Unknown remote gateway action')
  }
}

parentPort.on('message', event => {
  const message = event?.data || event
  if (message?.type === 'cleanup-response') {
    const resolver = cleanupRequests.get(message.id)
    cleanupRequests.delete(message.id)
    resolver?.(message.allowed)
    return
  }
  if (message?.type !== 'request' || typeof message.id !== 'string') return
  void action(message.action, message.payload).then(
    result => post({ type: 'response', id: message.id, result }),
    error => post({
      type: 'response',
      id: message.id,
      error: error instanceof Error ? error.message : 'Remote gateway action failed',
    }),
  )
})

process.on('disconnect', () => {
  void gateway?.stop().finally(() => process.exit(0))
})
