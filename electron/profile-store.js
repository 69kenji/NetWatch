'use strict'

const crypto = require('crypto')
const fs = require('fs')
const { atomicJson, normalizeProfileSettings, PROFILE_DEFAULTS } = require('./app-settings-store')

const PROFILE_STORE_VERSION = 3
const PROFILE_LIMIT = 12
const PROFILE_NAME_LIMIT = 40
const PROFILE_TAGLINE_LIMIT = 120
const PROFILE_FILE_LIMIT = 256 * 1024
const PROFILE_ID_PATTERN = /^[0-9a-f]{32}$/u
const AVATAR_PATTERN = /^(?:preset:(?:violet|blue|amber|rose|green)|image:[0-9a-f]{32})$/u

function createProfileId() {
  return crypto.randomUUID().replace(/-/gu, '')
}

function normalizeProfileName(value) {
  if (typeof value !== 'string') return null
  const name = value.replace(/[\u0000-\u001f\u007f]/gu, '').replace(/\s+/gu, ' ').trim()
  return name && name.length <= PROFILE_NAME_LIMIT ? name : null
}

function cleanText(value, limit) {
  return typeof value === 'string'
    ? value.replace(/[\u0000-\u001f\u007f]/gu, '').replace(/\s+/gu, ' ').trim().slice(0, limit)
    : ''
}

function normalizeProfile(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const id = typeof value.id === 'string' && PROFILE_ID_PATTERN.test(value.id) ? value.id : null
  const name = normalizeProfileName(value.name)
  if (!id || !name) return null
  const createdAt = Number.isFinite(Date.parse(value.createdAt)) ? new Date(value.createdAt).toISOString() : new Date().toISOString()
  return {
    id,
    name,
    tagline: cleanText(value.tagline, PROFILE_TAGLINE_LIMIT),
    avatar: AVATAR_PATTERN.test(value.avatar) ? value.avatar : 'preset:violet',
    kind: value.kind === 'guest' ? 'guest' : 'standard',
    createdAt,
    settings: normalizeProfileSettings(value.settings),
  }
}

function normalizeProfileStore(value, fallbackSettings = PROFILE_DEFAULTS) {
  if (![1, 2, PROFILE_STORE_VERSION].includes(value?.version) || !Array.isArray(value.profiles)) throw new Error('Unsupported profile data')
  if (!value.profiles.length || value.profiles.length > PROFILE_LIMIT) throw new Error('Invalid profile count')
  const profiles = value.profiles.map(normalizeProfile)
  if (profiles.some(profile => !profile)) throw new Error('Invalid profile')
  const uniqueIds = new Set(profiles.map(profile => profile.id))
  const uniqueNames = new Set(profiles.map(profile => profile.name.toLocaleLowerCase()))
  if (uniqueIds.size !== profiles.length || uniqueNames.size !== profiles.length) throw new Error('Duplicate profile')
  const initialId = uniqueIds.has(value.initialId) ? value.initialId : profiles[0].id
  const activeId = uniqueIds.has(value.activeId) ? value.activeId : profiles[0].id
  return {
    version: PROFILE_STORE_VERSION,
    activeId,
    initialId,
    profiles: profiles.map(profile => ({ ...profile, settings: normalizeProfileSettings(profile.settings, fallbackSettings) })),
  }
}

class ProfileStore {
  constructor(filePath, initialSettings = PROFILE_DEFAULTS) {
    this.filePath = filePath
    this.initialSettings = normalizeProfileSettings(initialSettings)
    this.writable = true
    this.value = this.load()
  }

  fresh() {
    const id = createProfileId()
    return {
      version: PROFILE_STORE_VERSION,
      activeId: id,
      initialId: id,
      profiles: [{ id, name: 'Default', tagline: '', avatar: 'preset:violet', kind: 'standard', createdAt: new Date().toISOString(), settings: this.initialSettings }],
    }
  }

  load() {
    try {
      if (fs.statSync(this.filePath).size > PROFILE_FILE_LIMIT) throw new Error('profile file is too large')
      const parsed = JSON.parse(fs.readFileSync(this.filePath, 'utf8'))
      const normalized = normalizeProfileStore(parsed, this.initialSettings)
      if (parsed.version !== PROFILE_STORE_VERSION) atomicJson(this.filePath, normalized)
      return normalized
    } catch (error) {
      const value = this.fresh()
      if (error?.code === 'ENOENT') {
        try {
          atomicJson(this.filePath, value)
        } catch (writeError) {
          this.writable = false
          console.warn('[Profiles] Profile data could not be created; profile changes are disabled.')
        }
      } else {
        this.writable = false
        console.warn('[Profiles] Profile data is unreadable; profile changes are disabled.')
      }
      return value
    }
  }

  assertWritable() {
    if (!this.writable) throw new Error('Profile data is unreadable. Restart NetWatch after checking disk access.')
  }

  isWritable() {
    return this.writable
  }

  persist(next) {
    this.assertWritable()
    atomicJson(this.filePath, next)
    this.value = next
  }

  state() {
    this.assertWritable()
    return {
      activeId: this.value.activeId,
      initialId: this.value.initialId,
      profiles: this.value.profiles.map(({ id, name, tagline, avatar, kind, createdAt }) => ({ id, name, tagline, avatar, kind, createdAt })),
    }
  }

  active() {
    this.assertWritable()
    return this.value.profiles.find(profile => profile.id === this.value.activeId)
  }

  getSettings() {
    // A damaged file disables writes, not access to the safe recovery settings.
    const profile = this.value.profiles.find(entry => entry.id === this.value.activeId)
    return { ...(profile?.settings || this.initialSettings) }
  }

  backupValue() {
    this.assertWritable()
    return JSON.parse(JSON.stringify(this.value))
  }

  replaceValue(value) {
    this.assertWritable()
    const next = normalizeProfileStore(value, this.initialSettings)
    this.persist(next)
    return this.state()
  }

  updateSettings(patch) {
    this.assertWritable()
    const profile = this.active()
    const settings = normalizeProfileSettings({ ...profile.settings, ...patch }, profile.settings)
    const next = {
      ...this.value,
      profiles: this.value.profiles.map(entry => entry.id === profile.id ? { ...entry, settings } : entry),
    }
    this.persist(next)
    return this.getSettings()
  }

  create(name, kind = 'standard') {
    this.assertWritable()
    const normalized = normalizeProfileName(name)
    if (!normalized) throw new Error(`Profile names must be between 1 and ${PROFILE_NAME_LIMIT} characters.`)
    if (this.value.profiles.length >= PROFILE_LIMIT) throw new Error(`NetWatch supports up to ${PROFILE_LIMIT} local profiles.`)
    if (this.value.profiles.some(profile => profile.name.toLocaleLowerCase() === normalized.toLocaleLowerCase())) throw new Error('A profile with that name already exists.')
    const profileKind = kind === 'guest' ? 'guest' : 'standard'
    const next = {
      ...this.value,
      profiles: [...this.value.profiles, { id: createProfileId(), name: normalized, tagline: '', avatar: 'preset:violet', kind: profileKind, createdAt: new Date().toISOString(), settings: { ...PROFILE_DEFAULTS } }],
    }
    this.persist(next)
    return this.state()
  }

  importProfile(value) {
    this.assertWritable()
    if (this.value.profiles.length >= PROFILE_LIMIT) throw new Error(`NetWatch supports up to ${PROFILE_LIMIT} local profiles.`)
    const baseName = normalizeProfileName(value?.name)
    if (!baseName) throw new Error('Imported profile name is invalid.')
    let name = baseName, suffix = 2
    while (this.value.profiles.some(profile => profile.name.toLocaleLowerCase() === name.toLocaleLowerCase())) {
      const ending = ` (${suffix++})`
      name = `${baseName.slice(0, PROFILE_NAME_LIMIT - ending.length)}${ending}`
    }
    const profile = normalizeProfile({
      ...value, id: createProfileId(), name,
      kind: value?.kind === 'guest' ? 'guest' : 'standard',
    })
    if (!profile) throw new Error('Imported profile is invalid.')
    this.persist({ ...this.value, profiles: [...this.value.profiles, profile] })
    return { profile: { ...profile, settings: { ...profile.settings } }, state: this.state() }
  }

  rename(id, name) {
    this.assertWritable()
    const profile = this.value.profiles.find(entry => entry.id === id)
    const normalized = normalizeProfileName(name)
    if (!profile || !normalized) throw new Error('Profile or profile name is invalid.')
    if (this.value.profiles.some(entry => entry.id !== id && entry.name.toLocaleLowerCase() === normalized.toLocaleLowerCase())) throw new Error('A profile with that name already exists.')
    const next = {
      ...this.value,
      profiles: this.value.profiles.map(entry => entry.id === id ? { ...entry, name: normalized } : entry),
    }
    this.persist(next)
    return this.state()
  }

  update(id, patch) {
    this.assertWritable()
    const profile = this.value.profiles.find(entry => entry.id === id)
    if (!profile || !patch || typeof patch !== 'object' || Array.isArray(patch)) throw new Error('Profile update is invalid.')
    if (Object.keys(patch).some(key => !['name', 'tagline', 'avatar', 'kind'].includes(key))) throw new Error('Profile update is invalid.')
    if ('avatar' in patch && (typeof patch.avatar !== 'string' || !AVATAR_PATTERN.test(patch.avatar))) throw new Error('Profile picture is invalid.')
    if ('kind' in patch && !['standard', 'guest'].includes(patch.kind)) throw new Error('Profile type is invalid.')
    if (patch.kind === 'guest' && this.value.profiles.length === 1) throw new Error('Create another profile before making this one a guest.')
    const name = 'name' in patch ? normalizeProfileName(patch.name) : profile.name
    const tagline = 'tagline' in patch ? cleanText(patch.tagline, PROFILE_TAGLINE_LIMIT) : profile.tagline
    const avatar = 'avatar' in patch && AVATAR_PATTERN.test(patch.avatar) ? patch.avatar : profile.avatar
    const kind = 'kind' in patch && ['standard', 'guest'].includes(patch.kind) ? patch.kind : profile.kind
    if (!name) throw new Error('Profile name is invalid.')
    if (this.value.profiles.some(entry => entry.id !== id && entry.name.toLocaleLowerCase() === name.toLocaleLowerCase())) throw new Error('A profile with that name already exists.')
    this.persist({ ...this.value, profiles: this.value.profiles.map(entry => entry.id === id ? { ...entry, name, tagline, avatar, kind } : entry) })
    return this.state()
  }

  switch(id) {
    this.assertWritable()
    const profile = this.value.profiles.find(entry => entry.id === id)
    if (!profile) throw new Error('Profile was not found.')
    if (id !== this.value.activeId) {
      this.persist({ ...this.value, activeId: id })
    }
    return this.state()
  }

  delete(id) {
    this.assertWritable()
    if (this.value.profiles.length === 1) throw new Error('The last profile cannot be deleted.')
    const index = this.value.profiles.findIndex(profile => profile.id === id)
    if (index < 0) throw new Error('Profile was not found.')
    const remaining = this.value.profiles.filter(profile => profile.id !== id)
    const activeId = this.value.activeId === id ? remaining[Math.min(index, remaining.length - 1)].id : this.value.activeId
    const initialId = this.value.initialId === id ? remaining[0].id : this.value.initialId
    this.persist({ ...this.value, activeId, initialId, profiles: remaining })
    return this.state()
  }

}

module.exports = {
  PROFILE_LIMIT,
  PROFILE_STORE_VERSION,
  ProfileStore,
  normalizeProfileName,
  normalizeProfileStore,
}
