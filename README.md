# NetWatch
<p align="center">
  <a href="https://github.com/69kenji/netwatch/releases/latest">
    <img alt="Release" src="https://img.shields.io/github/v/release/69kenji/netwatch?style=flat-square&color=7c5cff">
  </a>
  <img alt="Platform" src="https://img.shields.io/badge/platform-Windows-0078D4?style=flat-square&logo=windows11">
  <a href="https://github.com/69kenji/netwatch/blob/main/LICENSE">
    <img alt="License" src="https://img.shields.io/github/license/69kenji/netwatch?style=flat-square">
  </a>
  <a href="https://github.com/69kenji/netwatch/issues">
    <img alt="Issues" src="https://img.shields.io/github/issues/69kenji/netwatch?style=flat-square">
  </a>
  <a href="https://github.com/69kenji/netwatch/releases">
    <img alt="Downloads" src="https://img.shields.io/github/downloads/69kenji/netwatch/total?style=flat-square">
  </a>
</p>
<p align="center">
  <img
    src="https://github.com/user-attachments/assets/25b082e7-53be-4ce0-8ae4-61bcdada226a"
    alt="NetWatch icon"
    width="72"
    height="72"
  />
</p>

<p align="center">
  <strong>Privacy-focused Windows media client for movies, TV, and anime.</strong>
</p>

<p align="center">
  <img
    src="https://github.com/user-attachments/assets/7e043c70-ec4b-43c3-963a-5912f36b4484"
    alt="NetWatch home screen"
    width="1000"
  />
</p>

NetWatch is a Windows 11 media client built with Electron/React, FastAPI, libtorrent, Prowlarr, WireGuard, FlareSolverr, and mpv.

Torrent, metadata, subtitle, and indexer traffic runs inside a shared Docker/WSL network namespace behind an inner WireGuard tunnel. The Windows app talks to the local backend; it does not directly make provider or torrent connections.

## Features

- Home, Discover, and search for movies, TV, and anime through TMDB.
- Optional AniList title, movie, OVA, and installment data for anime release matching; TMDB supplies the catalog.
- Torrent discovery through your Prowlarr indexers, with optional bundled FlareSolverr support for indexers that need it.
- Direct libtorrent streaming with seek-aware buffering.
- Native mpv playback with fullscreen, seeking, audio tracks, subtitles, buffering, and network stats.
- Episode-to-release scrolling, Skip Intro, and Next Episode with automatic release selection within your default quality limit.
- A brief, transparent series-information overlay with genres, age rating, and content guidance when available.
- One saved desktop volume and mute setting across titles and app restarts.
- Optional next-episode autoplay with a cancellable countdown.
- A local media library with optional, confirmed TMDB matches.
- Saved audio/subtitle languages, subtitle appearance, playback speed, and video sizing.
- Local Keep Watching history, last-episode tracking, and standard or cinematic Home layouts.
- Optional Windows startup, background tray operation, and minimized startup.
- Optional OpenSubtitles and SubDL integration.
- Inner WireGuard routing with fail-closed startup checks, VPN-side DNS, and optional VPNBook profile reminders.
- Opt-in, TLS-pinned LAN streaming to the Android client; the PC handles torrents and VPN routing.

Skip Intro prefers explicit opening chapters in the video. Generic “Intro” and mixed story chapters are ignored. Anime can also use AniSkip timestamps matched to the installment, episode, and video duration; other TV titles use IntroDB where available. Different cuts can still have different timing, even at similar lengths. **Settings → Always skip intro** enables automatic skipping; it is off by default. Missing or invalid timestamps hide the control.

Next Episode appears at a known outro start, preferring the video's ending chapter. Without an outro marker, it appears during the final two minutes (or final 10% of shorter episodes). It stays available through post-credit scenes and at the end. Autoplay is off by default. Enable **Settings → Autoplay next episode** for a 10-second countdown; Cancel keeps the current episode playing. Pausing, seeking, opening a player menu, or buffering resets the countdown. A failed attempt does not repeat automatically. Autoplay may skip post-credit scenes; leave it off to choose when to advance.

The information overlay appears once per playback session, including resumed playback; buffering does not replay it. TMDB supplies genres and regional age ratings. Tiffara supplies community-rated series guidance, not episode-specific warnings. These lookups run through the VPN backend and send catalog identifiers, never torrent names or device credentials. Missing guidance is omitted, not treated as a clean rating.

TV and anime cards show progress through the last watched episode. Series Details opens on its season; **Jump to last watched** scrolls to the episode without selecting or playing it. Episode cards show saved progress or a watched overlay, resume from that point when played, and can be marked watched or reset from their right-click menu. This follows the active profile and the Keep Watching setting.

## Local library

Open **Library → Add folder** and choose a Windows drive folder. Refresh rescans it; removing a folder removes only its NetWatch entry and saved matches, never your files. Scans include up to 2,000 videos across 12 folders, skip linked directories and playlists, and do not search online. Network-share and device paths are not accepted.

Files play directly in mpv without torrent preparation. `S01E02` filenames identify episodes; local Next Episode requires one unambiguous consecutive file. Confirmed TMDB matches can identify a season boundary. Missing or duplicate episodes do not trigger an online release search. Embedded tracks and chapter-based intro/outro timing work locally.

**Match title** searches TMDB through the VPN. Select a title, enter season/episode numbers for TV, then choose **Confirm match** to save artwork, a synopsis, and catalog identifiers. Clear match removes that association. Once matched, catalog identifiers can also supply episode timings and guidance. Online subtitle search is a separate explicit action for local playback and sends the title and filename through the VPN.

**Open link** accepts a magnet link or public HTTPS `.torrent` URL. NetWatch downloads the torrent file through the VPN, then uses the normal torrent player. Direct links are not saved and do not appear in Keep Watching.

Local playback is desktop-only in this version: it does not populate shared Keep Watching, resume local timestamps, or expose folders to Android. Existing first-run setup remains required. After setup, local playback does not require the streaming services to be ready; matching, artwork retrieval, and online subtitles do.

## Playback preferences

Settings saves audio and subtitle language preferences for future playback. Embedded track availability determines which language mpv can select. Subtitle size, backdrop, and contrast apply to plain subtitles; **Embedded subtitle styling → Override** also replaces authored styling and may alter positioned anime signs.

The player’s speed and video-size buttons cycle through the available options and remember your selection across titles. **Fit** preserves the aspect ratio inside the window, **Fill** crops to cover it, **Original size** uses native video pixels, and **16:9** / **4:3** override the aspect ratio. These desktop preferences do not change the Android player's settings.

## Screenshots

<p align="center">
  <img src="https://github.com/user-attachments/assets/04395bde-31b2-466a-b282-33bbbcc31f1c" alt="NetWatch Discover screen" width="900" />
</p>

<p align="center">
  <img src="https://github.com/user-attachments/assets/a9ab5643-5aaa-4969-b2be-a7b395531cd9" alt="NetWatch series details screen" width="900" />
</p>

<p align="center">
  <img src="https://github.com/user-attachments/assets/608c2bfa-d9cd-4afa-a5ab-53589130b4ab" alt="NetWatch anime catalog" width="900" />
</p>

<p align="center">
  <img src="https://github.com/user-attachments/assets/00689fee-27ec-42f9-94f4-2ae4d5450fce" alt="NetWatch player" width="900" />
</p>

## Requirements

NetWatch supports **x64/AMD64 Windows 11 23H2 (build 22631) or newer**.

You need:

- WSL2 with a normal Linux distribution; Ubuntu is recommended.
- Docker Desktop using the WSL2 backend and integrated with that distribution.
- A full-tunnel WireGuard client configuration. Generic WireGuard and VPNBook profiles are supported.
- A TMDB API key.
- Prowlarr with at least one usable indexer and a 32-character API key.

Optional subtitle providers:

- OpenSubtitles: 32-character API key.
- SubDL: `subdl_` plus a 43-character key suffix. NetWatch supplies the `subdl_` prefix in the UI.

The installer can help install or enable WSL, Ubuntu, and Docker Desktop. Launch Setup normally; only the WSL servicing step requests UAC when needed.

## First run

1. Select **Generic WireGuard** or **VPNBook** and import the provider `.conf`.
2. NetWatch verifies the VPN, DNS path, kill switch, and egress.
3. Enter the required TMDB API key. OpenSubtitles and SubDL can be skipped.
4. Configure Prowlarr and enter its API key.
5. Start NetWatch.

OpenSubtitles and SubDL can be added or replaced later in **Settings**. Settings shows only whether a key is configured; stored key values are never displayed.

NetWatch rewrites imported WireGuard profiles into its managed format. It rejects provider command hooks and requires a full IPv4 tunnel (`0.0.0.0/0`) with an IPv4 DNS resolver. VPNBook uses the same path as other WireGuard profiles; its expiry estimate is only a reminder.

Private state is stored in the selected WSL distribution under:

```text
~/.local/share/netwatch/
```

Normal reinstall/upgrade preserves this state.

Upgrades preserve existing API credentials. Users upgrading from 1.0.4 or earlier may need to re-import the original provider WireGuard configuration once because the managed firewall format changed in 1.0.5.

## Prowlarr and FlareSolverr

NetWatch uses Prowlarr as its only indexer interface. Configure indexers there. FlareSolverr is off by default; enable it in NetWatch Settings only for indexers that require it, then assign its Prowlarr proxy tag to those indexers.

## Resource usage

Settings provides two resource profiles:

- **Standard** keeps the normal torrent concurrency, lookahead, connection limits, and 8 GiB torrent-buffer ceiling.
- **Reduced** lowers those limits and uses a 4 GiB torrent-buffer ceiling for systems with limited memory.

The buffer value is a maximum tmpfs size, not memory reserved at startup. Reduced mode trades concurrency and seek headroom for lower peak memory use. Prowlarr is required in both profiles; FlareSolverr runs only when enabled.

The engine admits up to 8 unfinished torrents and 16 total in Standard mode, or 2 unfinished and 4 total in Reduced mode. Metadata acquisition counts toward the unfinished limit. At capacity, close another playback session and retry; active playback is never evicted. The same release cannot play on the PC and phone simultaneously, but different releases can.

Streaming serves verified bytes as soon as they are available. Read-ahead adapts to observed requests within the profile's limit, and seeks replace old download priorities. Small container-index requests have separate, short-lived priorities.

The Windows player no longer stops buffering at 30 seconds. Its forward packet cache is limited to 512 MiB in Standard mode or 256 MiB in Reduced mode, so the time buffered varies with bitrate. These are packet-cache limits, not total application memory limits. No Windows disk cache is created. Torrent downloading continues independently within the temporary storage limit; this is not an unlimited or rolling storage cache.

## Desktop shortcuts

- `Ctrl+K` or `/` opens or focuses search from Home, Discover, Settings, and search results.
- `Alt+Left` / `Alt+Right` or the mouse Back / Forward buttons move through app navigation history.

## Build from source

Build from a normal Windows NTFS path, not `\\wsl.localhost\...`.

Required Node range: **`>=22.12 <23`**.

```powershell
npm ci
npm run package:dir
```

Test the unpacked application:

```text
release\win-unpacked\NetWatch.exe
```

Build the installer:

```powershell
npm run package:win
```

Output:

```text
release\NetWatch-Setup-2.0.0.exe
```

See [`packaging/PACKAGING.md`](packaging/PACKAGING.md) for release details.

## Source development

Git ignores private source configuration in `backend/.env`, `docker/wireguard/wg_confs/wg0.conf`, and `docker/prowlarr/config/`.

Run the Compose stack and network check from WSL:

```bash
docker compose -f docker/docker-compose.yml up -d
python3 docker/verify-networking.py
```

Treat the shared VPN namespace as a unit. Do not recreate only the VPN container while dependent services remain attached to the old namespace. The Android client is maintained in the separate [NetWatch Android repository](https://github.com/69kenji/NetWatch-Android).

## Troubleshooting

**VPN or DNS verification fails**  
Run:

```powershell
wsl -d Ubuntu -- sh -lc 'cd ~/.local/share/netwatch/runtime && python3 docker/verify-networking.py'
```

Replace `Ubuntu` if NetWatch uses another distribution.

Restart NetWatch after changing a host VPN. Build only from a Windows NTFS checkout.

## Security and privacy

The inner WireGuard tunnel is the authoritative Internet path for NetWatch's backend services. Windows-facing services are published on loopback only, and VPN-side control ports are blocked from WireGuard peers.

A Windows host VPN can be used as an extra layer, but it does not replace the inner tunnel.

Remote Access is disabled by default. When explicitly enabled, a separate TLS gateway binds only the selected private IPv4 interface; existing backend and service ports remain loopback-only. Pairing is short-lived, Android pins the PC identity, and devices can be revoked individually. See [`docs/remote-security-model.md`](docs/remote-security-model.md) and [`remote-gateway/protocol/remote-v1.md`](remote-gateway/protocol/remote-v1.md).

NetWatch does not promise anonymity or protection from a compromised host, VPN provider, dependency, or third-party service. See [`docs/network-threat-model.md`](docs/network-threat-model.md) for the full model and [`SECURITY.md`](SECURITY.md) for vulnerability reporting.

## License

NetWatch is licensed under **GPL-3.0-only**. See [`LICENSE`](LICENSE).

Third-party components keep their own licenses. See [`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md). Bundled mpv provenance and corresponding-source details are under [`resources/mpv/`](resources/mpv/README.md).

See [`DISCLAIMER.md`](DISCLAIMER.md) for the project disclaimer.
