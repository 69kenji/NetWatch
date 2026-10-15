# Changelog

## 1.2.0

- Added a local media library with folder browsing, filtering, direct playback, and optional TMDB matches confirmed before saving. Removing a folder never deletes media files.
- Added episode-to-release scrolling, Skip Intro, and Next Episode. Intro/outro timing uses explicit video chapters or matching metadata when available; streamed next episodes respect the selected quality limit.
- Added optional next-episode autoplay with a cancellable 10-second countdown. Missing local episodes never fall back to a torrent search.
- Added saved audio/subtitle language preferences, subtitle size, backdrop, contrast, and an option to override embedded subtitle styling.
- Added remembered playback speed and video sizing controls. Volume and mute are shared across titles and survive app restarts.
- Added a brief series-information overlay with genres, age rating, and content guidance when available.
- Improved streaming with earlier delivery of verified data, adaptive read-ahead, and tighter seek/cancellation handling. Cached torrent file metadata avoids repeated preparation work.
- Removed the Windows player's 30-second buffer cap. Read-ahead now uses a memory-bounded packet cache.
- Preserved unchanged VPN DNS files and added startup recovery for stale Docker Desktop DNS mounts without removing volumes.
- Hardened media-reference handling, pairing and session cancellation, torrent cleanup, and response-size limits. Updated affected dependencies.
- Enforced torrent ownership and resource-profile limits across desktop and phone playback. A second session using the same release now gets a busy response instead of interrupting the first.
- Restricted packaged runtime files to source, build inputs, and public configuration examples.

Local-library playback and the new playback preferences are Windows-only. Android remains unchanged. Local files are not shared with the phone or added to Keep Watching in this version.
