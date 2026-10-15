'use strict'

const { normalizePlaybackPreferences } = require('../shared/playback-preferences.mjs')
const LANGUAGE_ALIASES = {
  en: 'en,eng', el: 'el,ell,gre', ja: 'ja,jpn', es: 'es,spa', fr: 'fr,fra,fre',
  de: 'de,deu,ger', it: 'it,ita', pt: 'pt,por', ko: 'ko,kor', zh: 'zh,zho,chi',
  ar: 'ar,ara', ru: 'ru,rus', nl: 'nl,nld,dut', pl: 'pl,pol', tr: 'tr,tur',
  sv: 'sv,swe', no: 'no,nor,nob,nno',
}

function playbackProperties(settings) {
  const prefs = normalizePlaybackPreferences(settings)
  return {
    speed: prefs.playbackSpeed,
    'video-unscaled': prefs.playbackAspect === 'original' ? 'yes' : 'no',
    panscan: prefs.playbackAspect === 'fill' ? 1 : 0,
    'video-aspect-override': ['16:9', '4:3'].includes(prefs.playbackAspect) ? prefs.playbackAspect : 'no',
    'sub-scale': prefs.subtitleScale,
    'sub-color': prefs.subtitleContrast === 'yellow' ? '#FFFF66' : '#FFFFFF',
    'sub-outline-color': '#000000',
    'sub-outline-size': prefs.subtitleContrast === 'high' ? 3 : 1.65,
    'sub-border-style': prefs.subtitleBackdrop ? 'background-box' : 'outline-and-shadow',
    'sub-back-color': prefs.subtitleBackdrop ? '#B0000000' : '#00000000',
    'sub-ass-override': prefs.overrideSubtitleStyles ? 'force' : 'scale',
  }
}

function playbackArguments(settings) {
  const prefs = normalizePlaybackPreferences(settings)
  return [
    ...Object.entries(playbackProperties(prefs)).map(([name, value]) => `--${name}=${value}`),
    `--alang=${LANGUAGE_ALIASES[prefs.preferredAudioLanguage] || ''}`,
    `--slang=${LANGUAGE_ALIASES[prefs.preferredSubtitleLanguage] || ''}`,
    `--sid=${prefs.preferredSubtitleLanguage === 'none' ? 'no' : 'auto'}`,
  ]
}

module.exports = { playbackArguments, playbackProperties }
