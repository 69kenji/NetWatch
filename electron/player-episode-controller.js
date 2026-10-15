'use strict'

const { selectAutomaticRelease: firstAllowedRelease } = require('../shared/quality-policy.mjs')

function episodePath(session) {
  const media = session?.mediaItem
  const id = media?.tmdb_id || media?.id
  if (media?.type !== 'tv' || !Number.isInteger(id) || id < 1 || id > 2147483647 ||
      !Number.isInteger(media.season) || media.season < 0 || media.season > 9999 ||
      !Number.isInteger(media.episode) || media.episode < 1 || media.episode > 9999) return null
  return `/api/metadata/series/${id}/episodes/${media.season}/${media.episode}`
}

function createPlayerEpisodeController({ backendJson, getAppSettings }) {
  async function info(session, duration = 0) {
    const route = episodePath(session)
    if (!route) return null
    return {
      ...await backendJson(`${route}/playback-info?duration=${duration}`, { method: 'GET' }, 40_000),
      alwaysSkipIntro: getAppSettings().alwaysSkipIntro === true,
    }
  }

  async function successor(session, signal) {
    const route = episodePath(session)
    if (!route) return null
    const result = await backendJson(`${route}/next-episode`, { method: 'GET', signal }, 20_000)
    const episode = result?.episode
    if (!episode || !Number.isInteger(episode.season_number) || !Number.isInteger(episode.episode_number) ||
        episode.season_number < 0 || episode.season_number > 9999 || episode.episode_number < 1 ||
        episode.episode_number > 9999 || episode.season_number < session.mediaItem.season ||
        (episode.season_number === session.mediaItem.season && episode.episode_number <= session.mediaItem.episode)) return null
    return episode
  }

  async function resolveNext(session, assertCurrent, signal) {
    const episode = await successor(session, signal)
    assertCurrent()
    if (!episode) throw new Error('No released next episode is available.')
    const id = session.mediaItem.tmdb_id || session.mediaItem.id
    const data = await backendJson(
      `/api/metadata/series/${id}/episodes/${episode.season_number}/${episode.episode_number}/stream-options?min_seeders=1&anime=${session.mediaItem.is_anime === true}`,
      { method: 'GET', signal }, 120_000,
    )
    assertCurrent()
    const release = firstAllowedRelease(data?.results, getAppSettings().defaultQuality)
    if (!release) throw new Error(data?.release_error ? 'Release search is unavailable. Try again.' : 'No release matches your default quality. Try again later.')
    const code = `S${String(episode.season_number).padStart(2, '0')}E${String(episode.episode_number).padStart(2, '0')}`
    return {
      releaseRef: release.release_ref,
      expectedHash: release.info_hash || release.infoHash || null,
      title: `${session.mediaItem.title} · ${code} · ${episode.name || ''}`,
      mediaName: `${session.mediaItem.title} ${code}`,
      mediaItem: {
        ...session.mediaItem, season: episode.season_number, episode: episode.episode_number,
        episode_title: episode.name || '', overview: episode.overview || session.mediaItem.overview,
      },
    }
  }

  return { info, successor, resolveNext }
}

module.exports = { createPlayerEpisodeController, episodePath, firstAllowedRelease }
