'use strict'

function normalizeChapters(value) {
  if (!Array.isArray(value) || value.length > 256) return []
  const chapters = []
  for (const chapter of value) {
    if (!Number.isFinite(chapter?.time) || chapter.time < 0 || chapter.time > 14400 ||
        (chapters.length && chapter.time <= chapters[chapters.length - 1].time)) return []
    chapters.push({ time: chapter.time, title: typeof chapter.title === 'string' ? chapter.title.slice(0, 120) : '' })
  }
  return chapters
}

function validSegment(segment, kind, duration) {
  if (!Number.isFinite(duration) || duration <= 0 || duration > 14400 ||
      !Number.isFinite(segment?.start) || !Number.isFinite(segment?.end) ||
      segment.start < 0 || segment.start >= segment.end || segment.end > duration ||
      segment.end - segment.start > (kind === 'intro' ? 300 : 600)) return null
  if (kind === 'intro' ? segment.start >= duration / 2 || segment.end >= duration : segment.start < duration / 2) return null
  return { start: segment.start, end: segment.end }
}

function chapterSegments(state) {
  const chapters = normalizeChapters(state?.chapters)
  const result = {}
  const names = {
    intro: /^(?:op\d*|opening(?:\s+(?:credits|theme|song))?)(?:\s*[:\-–—]\s*.+|\s*\([^()]+\))?$/iu,
    outro: /^(?:ed\d*|outro|ending(?:\s+(?:credits|theme|song))?|end credits|credits)(?:\s*[:\-–—]\s*.+|\s*\([^()]+\))?$/iu,
  }
  for (const kind of ['intro', 'outro']) {
    const matches = []
    for (let i = 0; i < chapters.length; i++) {
      const title = chapters[i].title.trim().replace(/^\d{1,3}\s*[.\-:]\s*/u, '')
        .replace(/^[\[(]((?:op|ed)\d*)[\])]$/iu, '$1')
      // "Intro" often means the cold open, not the opening credits. Mixed
      // chapters include story footage and are never a safe skip range.
      if (!names[kind].test(title) || /\b(?:story|recap|cold open|prologue|part [ab]|preview|epilogue)\b/iu.test(title)) continue
      // An opening needs a following chapter; never guess where dialogue resumes.
      const end = chapters[i + 1]?.time ?? (kind === 'outro' ? state.duration : NaN)
      const segment = validSegment({ start: chapters[i].time, end }, kind, state.duration)
      if (segment) matches.push(segment)
    }
    if (matches.length === 1) result[kind] = matches[0]
  }
  return result
}

function playbackDuration(state) {
  return Number.isFinite(state?.duration) && state.duration > 0 && state.duration <= 14400 ? Math.round(state.duration) : 0
}

function withFileTimings(info, state) {
  if (!info) return info
  const chapters = chapterSegments(state)
  // Allow only the request's rounding margin at the end of the file.
  const outro = info.outro && info.outro.end > state.duration && info.outro.end <= state.duration + 0.5
    ? { ...info.outro, end: state.duration } : info.outro
  return {
    ...info,
    intro: chapters.intro || validSegment(info.intro, 'intro', state.duration),
    outro: chapters.outro || validSegment(outro, 'outro', state.duration),
  }
}

module.exports = { normalizeChapters, validSegment, chapterSegments, playbackDuration, withFileTimings }
