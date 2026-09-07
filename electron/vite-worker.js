'use strict'

const path = require('path')

async function run() {
  const action = process.argv[2]
  if (action !== 'serve' && action !== 'build') {
    throw new Error('Vite worker action must be serve or build')
  }

  const mode = action === 'serve' ? 'development' : 'production'
  process.env.NODE_ENV = mode

  const projectRoot = path.resolve(__dirname, '..')
  const configFile = path.join(projectRoot, 'vite.config.mts')
  const vite = await import('vite')

  if (action === 'serve') {
    const server = await vite.createServer({
      root: projectRoot,
      configFile,
      clearScreen: false,
      mode,
      server: {
        host: '127.0.0.1',
        port: 5173,
        strictPort: true,
      },
    })
    await server.listen()
    server.printUrls()
    return
  }

  await vite.build({
    root: projectRoot,
    configFile,
    clearScreen: false,
    mode,
  })
}

run().catch(error => {
  console.error(error instanceof Error ? error.stack || error.message : String(error))
  process.exitCode = 1
})
