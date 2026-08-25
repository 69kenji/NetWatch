'use strict'
const openButton = document.getElementById('openProwlarr')
const saveButton = document.getElementById('saveProwlarr')
const input = document.getElementById('prowlarrKey')
const message = document.getElementById('message')
const progress = document.getElementById('progress')
let busy = false
let ready = false
const REQUIRED_KEY_LENGTH = 32

function setMessage(text, kind = '') {
  message.textContent = text
  message.className = `message${kind ? ` ${kind}` : ''}`
}
function setBusy(next, text = '') {
  busy = next
  progress.classList.toggle('active', next)
  openButton.disabled = next || !ready
  saveButton.disabled = next || !ready || input.value.trim().length !== REQUIRED_KEY_LENGTH
  input.disabled = next || !ready
  if (text) setMessage(text)
}
function clearSecret() { input.value = '' }

async function prepare() {
  setBusy(true, 'Preparing Prowlarr…')
  try {
    const result = await window.netwatchProwlarrSetup.prepare()
    ready = true
    if (result?.recovered) {
      setMessage('Prowlarr verified.', 'success')
    } else if (result?.pendingCleared) {
      setMessage('Previous Prowlarr key was not valid. Enter it again.', 'error')
    } else {
      setMessage('Prowlarr ready.', 'success')
    }
  } catch (error) {
    ready = false
    setMessage(error?.message || 'Prowlarr could not be prepared safely.', 'error')
  } finally {
    setBusy(false)
  }
}

input.addEventListener('input', () => {
  if (!busy) saveButton.disabled = !ready || input.value.trim().length !== REQUIRED_KEY_LENGTH
})

openButton.addEventListener('click', async () => {
  if (busy || !ready) return
  try { await window.netwatchProwlarrSetup.open() }
  catch (error) { setMessage(error?.message || 'Prowlarr is not ready.', 'error') }
})

saveButton.addEventListener('click', async () => {
  if (busy || !ready) return
  if (input.value.trim().length !== REQUIRED_KEY_LENGTH) {
    setMessage('Prowlarr API key must be exactly 32 characters.', 'error')
    return
  }
  setBusy(true, 'Verifying Prowlarr…')
  try {
    await window.netwatchProwlarrSetup.submitKey(input.value)
    clearSecret()
    setMessage('Setup complete.', 'success')
  } catch (error) {
    clearSecret()
    setMessage(error?.message || 'Prowlarr API key validation failed.', 'error')
  } finally {
    setBusy(false)
  }
})

window.addEventListener('beforeunload', clearSecret)
prepare()
