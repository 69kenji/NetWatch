const QUALITY_WEIGHT = Object.freeze({
  '2160p': 4,
  '4k': 4,
  '1080p': 3,
  '720p': 2,
  '480p': 1,
})

function resolutionWeight(value) {
  return QUALITY_WEIGHT[String(value || '').trim().toLowerCase()] || 0
}

function selectAutomaticRelease(results, ceiling = 'all') {
  if (!Array.isArray(results)) return null
  const maximum = ceiling === 'all' ? Number.POSITIVE_INFINITY : resolutionWeight(ceiling)
  if (ceiling !== 'all' && !maximum) return null
  return results.find(item => {
    const weight = resolutionWeight(item?.resolution)
    return item && typeof item.release_ref === 'string' && /^[A-Za-z0-9_-]{32,128}$/u.test(item.release_ref) &&
      (ceiling === 'all' || (weight > 0 && weight <= maximum))
  }) || null
}

module.exports = { resolutionWeight, selectAutomaticRelease }
