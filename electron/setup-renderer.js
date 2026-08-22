'use strict'

const state = { current: null, busy: false }
const el = (id) => document.getElementById(id)
const message = el('message')
const progress = el('progress')
const wgStep = el('wgStep')
const apiStep = el('apiStep')
const doneStep = el('doneStep')
const stageVpn = el('stageVpn')
const stageApi = el('stageApi')

function setBusy(busy, text = '') {
  state.busy = busy
  progress.classList.toggle('active', busy)
  document.querySelectorAll('button').forEach(button => { button.disabled = busy })
  if (text) setMessage(text)
  if (!busy) render(state.current)
}

function finishBusy(text = '', kind = '') {
  // render() restores state-dependent controls, but it also writes the generic
  // step message. Apply the operation result *after* that render so validation
  // errors and success notices cannot be silently overwritten.
  setBusy(false)
  if (text) setMessage(text, kind)
}

function setMessage(text, kind = '') {
  message.textContent = text || ''
  message.className = `message${kind ? ` ${kind}` : ''}`
}

function clearInputs() {
  for (const id of ['tmdb', 'opensubtitles', 'subdl']) el(id).value = ''
}

function showStep(target) {
  for (const node of [wgStep, apiStep, doneStep]) node.classList.toggle('active', node === target)
}

function renderApiFields(configured = {}) {
  for (const name of ['tmdb', 'opensubtitles', 'subdl']) {
    const wrapper = document.querySelector(`.field[data-key="${name}"]`)
    const input = el(name)
    let badge = wrapper.querySelector('.configured')
    if (configured[name]) {
      input.disabled = true
      input.value = ''
      if (!badge) {
        badge = document.createElement('div')
        badge.className = 'configured'
        badge.textContent = 'Configured'
        wrapper.appendChild(badge)
      }
    } else {
      input.disabled = false
      if (badge) badge.remove()
    }
  }
}

function setStage(name) {
  stageVpn.classList.toggle('active', name === 'vpn')
  stageVpn.classList.toggle('complete', name !== 'vpn')
  stageApi.classList.toggle('active', name === 'api')
  stageApi.classList.toggle('complete', name === 'done')
}

function render(next) {
  if (!next) return
  state.current = next
  if (state.busy) return
  const wg = next.wg || {}
  const configured = next.env?.configured || {}
  el('wgState').textContent = wg.valid ? 'Ready' : wg.exists ? 'Needs attention' : 'Required'
  el('wgState').className = `state-chip ${wg.valid ? 'good' : wg.exists ? 'bad' : ''}`
  el('wgConfigHint').textContent = wg.valid ? 'Configuration secured' : wg.exists ? 'Import a replacement .conf file' : 'Import your provider .conf file'
  el('vpnHint').textContent = next.vpn_verified ? 'Verified' : wg.valid ? 'Ready to verify' : 'Not verified'
  el('replaceWg').style.display = wg.valid ? '' : 'none'
  el('importWg').style.display = wg.valid ? 'none' : ''
  el('verifyVpn').disabled = !wg.valid

  if (!wg.valid || !next.vpn_verified) {
    setStage('vpn')
    showStep(wgStep)
    if (!wg.valid) {
      setMessage(wg.exists ? 'WireGuard configuration needs replacement.' : '')
    } else {
      setMessage('')
    }
    return
  }

  const apiComplete = configured.tmdb && configured.opensubtitles && configured.subdl
  if (!apiComplete) {
    setStage('api')
    renderApiFields(configured)
    showStep(apiStep)
    setMessage('')
    return
  }

  setStage('done')
  showStep(doneStep)
  setMessage('Opening Prowlarr setup…', 'success')
}

async function refresh() {
  try {
    const next = await window.netwatchSetup.getState()
    render(next)
  } catch (_) {
    setMessage('NetWatch could not inspect the secure setup state.', 'error')
  }
}

async function importWireGuard() {
  if (state.busy) return
  setBusy(true, 'Importing WireGuard configuration…')
  let notice = { text: '', kind: '' }
  try {
    const result = await window.netwatchSetup.chooseWireGuard()
    state.current = result.state || state.current
    notice = result.cancelled
      ? { text: 'WireGuard import cancelled.', kind: '' }
      : { text: 'WireGuard imported.', kind: 'success' }
  } catch (error) {
    notice = { text: error?.message || 'WireGuard configuration was rejected.', kind: 'error' }
  } finally {
    finishBusy(notice.text, notice.kind)
  }
}

async function verifyVpn() {
  if (state.busy) return
  setBusy(true, 'Verifying VPN…')
  let notice = { text: '', kind: '' }
  try {
    const result = await window.netwatchSetup.verifyVpn()
    state.current = result.state || state.current
    notice = { text: 'VPN verified.', kind: 'success' }
  } catch (error) {
    try {
      const latest = await window.netwatchSetup.getState()
      state.current = latest
    } catch (_) {}
    notice = { text: error?.message || 'VPN verification failed. NetWatch will not continue.', kind: 'error' }
  } finally {
    finishBusy(notice.text, notice.kind)
  }
}

async function saveApi() {
  if (state.busy) return
  const configured = state.current?.env?.configured || {}
  const payload = {}
  for (const name of ['tmdb', 'opensubtitles', 'subdl']) {
    if (!configured[name]) payload[name] = el(name).value
  }
  setBusy(true, 'Validating API keys…')
  let notice = { text: '', kind: '' }
  try {
    const result = await window.netwatchSetup.submitApiCredentials(payload)
    state.current = result.state || state.current
    notice = { text: 'API keys verified.', kind: 'success' }
  } catch (error) {
    notice = { text: error?.message || 'API credential validation failed.', kind: 'error' }
  } finally {
    clearInputs()
    for (const key of Object.keys(payload)) payload[key] = ''
    finishBusy(notice.text, notice.kind)
  }
}

el('importWg').addEventListener('click', importWireGuard)
el('replaceWg').addEventListener('click', importWireGuard)
el('verifyVpn').addEventListener('click', verifyVpn)
el('saveApi').addEventListener('click', saveApi)
document.querySelectorAll('[data-site]').forEach(button => {
  button.addEventListener('click', () => window.netwatchSetup.openCredentialSite(button.dataset.site))
})

window.addEventListener('beforeunload', clearInputs)
refresh()
