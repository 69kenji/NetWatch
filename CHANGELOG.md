# Changelog

### 1.2.0

- feat(library): add folder browsing, filtering, direct playback, and confirmed tmdb matches without deleting media when folders are removed
- feat(player): add episode-to-release scrolling, skip intro, and next episode using chapter or metadata timings and selected stream quality
- feat(player): add optional next-episode autoplay with a cancellable 10-second countdown and no torrent fallback for missing local episodes
- feat(player): save audio and subtitle languages, subtitle size, backdrop, contrast, and embedded style overrides
- feat(player): remember playback speed and video sizing and persist shared volume and mute settings
- feat(player): add series information overlay with genres, age rating, and content guidance
- perf(streaming): deliver verified data earlier and improve adaptive read-ahead, seeking, cancellation, and torrent metadata caching
- perf(player): replace the windows 30-second buffer cap with a memory-bounded packet cache
- fix(vpn): preserve unchanged dns files and recover stale docker desktop dns mounts without removing volumes
- fix(security): harden media references, pairing, session cancellation, torrent cleanup, and response-size limits and update affected dependencies
- fix(streaming): enforce torrent ownership and resource-profile limits and return busy when another session uses the same release
- chore(packaging): restrict runtime files to source, build inputs, and public configuration examples
- docs: clarify windows-only local playback and preferences, unchanged android behavior, and local-file sharing and keep watching limitations
