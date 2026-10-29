### 2.0.1
  * fix(player): dismiss keyboard seek feedback automatically

### 2.0.0
  * feat(profiles): add local profiles with separate preferences, lists, collections and watch history
  * feat(profiles): add profile pictures, names and taglines
  * feat(profiles): add local profile switching
  * feat(profiles): add viewing stats, series progress, recent activity and temporary guest profiles
  * feat(profiles): add profile import and export with selective history and progress restore
  * feat(library): add My List, custom collections and an automatic Watched collection
  * feat(library): add collection, watched, My List, playback and details actions to title menus
  * feat(library): add collection filtering, sorting and a dedicated Collections view
  * feat(library): add magnet link and HTTPS torrent-file streaming
  * feat(search): save recent searches for each profile
  * feat(history): add searchable local viewing history with filters, playback and removal controls
  * feat(home): add local recommendations, per-profile rail order and hidden sections
  * feat(notifications): add optional new-episode alerts for watched series
  * feat(queue): add a temporary playback queue for titles, episodes and local files
  * feat(data): add backup and selective restore
  * feat(appearance): add Minimal Acrylic, Frosted Glass and Liquid Glass themes
  * feat(appearance): add accent colors, interface density, material strength and custom backgrounds
  * feat(appearance): extend translucent materials across the interface
  * feat(accessibility): add text scaling, reduced motion, high contrast and reduced transparency
  * feat(navigation): add directional keyboard and controller navigation, controller context actions and TV layout support
  * feat(player): open playback inside the NetWatch player window
  * feat(player): keep playback running when NetWatch is minimized to the tray
  * feat(player): add a next-episode preview and smoother countdown animation
  * feat(progress): add Jump to last watched and open the last watched season
  * feat(progress): show episode progress and watched status in title details
  * feat(progress): resume episodes directly from title details
  * feat(progress): add play, restart, mark watched and mark unwatched episode actions
  * feat(progress): add whole-season watched controls and Play next unwatched
  * feat(updates): add signed Windows update checks and installer downloads
  * style(ui): unify icons, menus, settings controls and translucent surfaces
  * fix(streaming): fix brief video artifacting while keeping the 512 MiB playback buffer
  * fix(streaming): resume the same torrent after restarting NetWatch
  * fix(progress): keep unfinished episodes in Keep Watching when another episode is completed
  * fix(security): harden torrent links, local paths, images, profiles and backups
  * fix(security): restrict navigation and external links and verify packaged files
  * fix(security): update vulnerable dependencies

### 1.2.0
  * feat(library): add folder browsing, filtering, direct playback and confirmed TMDB matches without deleting media when folders are removed
  * feat(player): add episode-to-release scrolling, skip intro and next episode using chapter or metadata timings and selected stream quality
  * feat(player): add optional next-episode autoplay with a cancellable 10-second countdown and no torrent fallback for missing local episodes
  * feat(player): save audio and subtitle languages, subtitle size, backdrop, contrast and embedded style overrides
  * feat(player): remember playback speed and video sizing and persist shared volume and mute settings
  * feat(player): add series information overlay with genres, age rating and content guidance
  * perf(streaming): deliver verified data earlier and improve adaptive read-ahead, seeking, cancellation and torrent metadata caching
  * perf(player): replace the Windows 30-second buffer cap with a memory-bounded packet cache
  * fix(vpn): preserve unchanged DNS files and recover stale Docker Desktop DNS mounts without removing volumes
  * fix(security): harden media references, pairing, session cancellation, torrent cleanup and response-size limits and update affected dependencies
  * fix(streaming): enforce torrent ownership and resource-profile limits and return busy when another session uses the same release
