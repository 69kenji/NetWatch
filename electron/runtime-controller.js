'use strict'

const { app, utilityProcess } = require('electron')
const fs = require('fs')
const path = require('path')
const { httpOk, sleep, waitForHttp } = require('./process-utils')

function createRuntimeController({
  appSettings,
  backendBaseUrl,
  backendJson,
  getRuntimeStatus,
  isDev,
  resetRuntimeStatus,
  setRuntimeStatus,
  useViteDevServer,
  wslRuntime,
}) {
  if (!appSettings || typeof backendJson !== 'function' || !wslRuntime) {
    throw new Error('Runtime controller dependencies are invalid')
  }

  const {
    containerHealth,
    launchDockerDesktopIfPresent,
    runWsl,
    startComposeWithVpnSelfHeal,
    verifyVpnIsolation,
    waitForDocker,
  } = wslRuntime
  let viteProcess = null
  let viteOwned = false
  let runtimeStartupPromise = null

  async function ensureVite() {
    if (!isDev) return
    if (await httpOk('http://127.0.0.1:5173/', 800)) return
    const viteWorker = path.join(__dirname, 'vite-worker.js')
  
    let recentOutput = ''
    let exited = false
    let exitCode = null
    let spawnError = null
  
    const rememberOutput = (prefix, chunk) => {
      const text = chunk.toString()
      recentOutput = `${recentOutput}${prefix}${text}`.slice(-12_000)
      return text.trimEnd()
    }
  
    viteProcess = utilityProcess.fork(viteWorker, ['serve'], {
      cwd: app.getPath('temp'),
      stdio: 'pipe',
      env: {
        ...process.env,
        BROWSER: 'none',
      },
      serviceName: 'NetWatch Vite Development Server',
    })
    viteOwned = true

    viteProcess.stdout?.on('data', chunk => {
      const line = rememberOutput('', chunk)
      if (line) console.log('[Vite]', line)
    })
    viteProcess.stderr?.on('data', chunk => {
      const line = rememberOutput('', chunk)
      if (line) console.error('[Vite]', line)
    })
    viteProcess.once('error', details => {
      spawnError = new Error(`Vite utility process failed: ${details?.type || 'unknown error'}`)
    })
    viteProcess.once('exit', code => {
      exited = true
      exitCode = code
    })
  
    const deadline = Date.now() + 30_000
    while (Date.now() < deadline) {
      if (await httpOk('http://127.0.0.1:5173/', 800)) return
  
      if (spawnError) {
        throw new Error(`Could not launch the hidden Vite process: ${spawnError.message}`)
      }
      if (exited) {
        const details = recentOutput.trim()
        throw new Error(
          `Vite exited before becoming ready (exit code ${exitCode}).${details ? `\n\n${details}` : ''}`,
        )
      }
      await sleep(250)
    }
  
    const details = recentOutput.trim()
    throw new Error(
      `Vite did not become ready on http://127.0.0.1:5173${details ? `\n\n${details}` : ''}`,
    )
  }
  
  
  async function ensureRendererBuild() {
    if (app.isPackaged || !isDev) return
  
    if (useViteDevServer) {
      await ensureVite()
      return
    }
  
    const projectRoot = path.resolve(__dirname, '..')
    const distIndex = path.join(projectRoot, 'dist', 'index.html')
    const distPlayer = path.join(projectRoot, 'dist', 'player.html')
    const viteWorker = path.join(__dirname, 'vite-worker.js')

    let recentOutput = ''
    const child = utilityProcess.fork(viteWorker, ['build'], {
      cwd: app.getPath('temp'),
      stdio: 'pipe',
      env: {
        ...process.env,
        BROWSER: 'none',
      },
      serviceName: 'NetWatch Renderer Build',
    })

    const rememberOutput = (prefix, chunk) => {
      const text = chunk.toString()
      recentOutput = `${recentOutput}${prefix}${text}`.slice(-12_000)
      return text.trimEnd()
    }
  
    child.stdout?.on('data', chunk => {
      const line = rememberOutput('', chunk)
      if (line) console.log('[Renderer build]', line)
    })
    child.stderr?.on('data', chunk => {
      const line = rememberOutput('', chunk)
      if (line) console.error('[Renderer build]', line)
    })

    await new Promise((resolve, reject) => {
      let settled = false
      const timer = setTimeout(() => {
        if (settled) return
        settled = true
        child.kill()
        reject(new Error(`Renderer build timed out after 90 seconds.${recentOutput.trim() ? `\n\n${recentOutput.trim()}` : ''}`))
      }, 90_000)

      child.once('error', details => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        reject(new Error(`Renderer build utility process failed: ${details?.type || 'unknown error'}`))
      })
      child.once('exit', code => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        if (code === 0) {
          resolve()
        } else {
          reject(new Error(
            `Renderer build exited with code ${code}.${recentOutput.trim() ? `\n\n${recentOutput.trim()}` : ''}`,
          ))
        }
      })
    })
  
    if (!fs.existsSync(distIndex) || !fs.existsSync(distPlayer)) {
      throw new Error('Renderer build completed but dist/index.html or dist/player.html is missing.')
    }
  }
  
  function stopOwnedVite() {
    if (!viteOwned || !viteProcess) return
    const child = viteProcess
    viteOwned = false
    viteProcess = null
    try {
      child.kill()
    } catch (_) {}
  }
  
  async function ensureInfrastructure() {
    setRuntimeStatus({
      phase: 'docker',
      ready: false,
      message: 'Checking Docker…',
      error: null,
      services: { docker: 'starting' },
    })
  
    let dockerReady = false
    try {
      await runWsl(['docker', 'info', '--format', '{{.ServerVersion}}'], 5000)
      dockerReady = true
    } catch (_) {
      setRuntimeStatus({ message: 'Starting Docker Desktop…' })
      launchDockerDesktopIfPresent()
      dockerReady = await waitForDocker(90_000)
    }
  
    if (!dockerReady) {
      throw new Error('Docker is unavailable. Start Docker Desktop, then retry NetWatch startup.')
    }
  
    // Before FlareSolverr became optional, upgrades always had this container.
    // Preserve that behavior only when an existing installation is detected;
    // genuinely new installations keep the new default of Off.
    if (!appSettings.wasPersisted('flareSolverrEnabled')) {
      const existingFlareSolverr = await containerHealth('nw_flaresolverr')
      appSettings.update({ flareSolverrEnabled: existingFlareSolverr !== 'missing' })
    }
  
    setRuntimeStatus({
      phase: 'services',
      message: 'Starting private streaming services…',
      services: { docker: 'ready', stack: 'starting' },
    })
  
    await startComposeWithVpnSelfHeal()
  
    setRuntimeStatus({
      message: 'Waiting for NetWatch API…',
      services: { stack: 'ready', backend: 'starting' },
    })
  
    const backendReady = await waitForHttp(`${backendBaseUrl}/api/health`, 90_000, 500)
    if (!backendReady) throw new Error('The NetWatch backend did not become healthy in time.')
  
    setRuntimeStatus({
      message: 'Checking torrent engine and search service…',
      services: { backend: 'ready', torrentEngine: 'starting', prowlarr: 'starting' },
    })
  
    const deadline = Date.now() + 60_000
    let lastPayload = null
    while (Date.now() < deadline) {
      try {
        lastPayload = await backendJson('/api/diagnostics/dependencies', { method: 'GET' }, 5000)
      } catch (_) {
        await sleep(1000)
        continue
      }
  
      if (lastPayload?.all_connected) {
        // Verify the complete privacy topology on every launch, not only after a
        // cold-boot repair. A failed privacy check is fatal and is intentionally
        // not swallowed by the dependency retry loop.
        await verifyVpnIsolation()
        setRuntimeStatus({
          phase: 'ready',
          ready: true,
          message: 'Ready',
          error: null,
          services: { stack: 'ready', backend: 'ready', torrentEngine: 'ready', prowlarr: 'ready' },
        })
        return
      }
      await sleep(1000)
    }
  
    const engineError = lastPayload?.torrent_engine?.error || lastPayload?.torrent_engine?.status
    const prowlarrError = lastPayload?.prowlarr?.error || lastPayload?.prowlarr?.status
    throw new Error(
      `Dependencies did not become ready.${engineError ? ` torrent-engine: ${engineError}.` : ''}${prowlarrError ? ` Prowlarr: ${prowlarrError}.` : ''}`,
    )
  }
  
  function startRuntime() {
    if (runtimeStartupPromise) return runtimeStartupPromise
    runtimeStartupPromise = ensureInfrastructure()
      .catch(error => {
        setRuntimeStatus({
          phase: 'error',
          ready: false,
          message: 'Startup failed',
          error: error instanceof Error ? error.message : String(error),
        })
        throw error
      })
      .finally(() => {
        runtimeStartupPromise = null
      })
    return runtimeStartupPromise
  }
  
  async function retryRuntime() {
    if (runtimeStartupPromise) {
      const status = getRuntimeStatus()
      return { ...status, services: { ...status.services } }
    }
    resetRuntimeStatus()
    try {
      await startRuntime()
    } catch (_) {}
    const status = getRuntimeStatus()
    return { ...status, services: { ...status.services } }
  }

  return {
    ensureRendererBuild,
    retry: retryRuntime,
    start: startRuntime,
    stopDevelopmentServer: stopOwnedVite,
  }
}

module.exports = { createRuntimeController }
