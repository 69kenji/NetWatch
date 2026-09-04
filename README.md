# NetWatch

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
- Torrent discovery through your Prowlarr indexers, with bundled FlareSolverr support for indexers that need it.
- Direct libtorrent streaming with seek-aware buffering.
- Native mpv playback with fullscreen, seeking, audio tracks, subtitles, buffering, and network stats.
- Optional OpenSubtitles and SubDL integration.
- Inner WireGuard routing with fail-closed startup checks, VPN-side DNS, and optional VPNBook profile reminders.
- Opt-in, TLS-pinned LAN streaming to the Android thin client; the PC remains the torrent and VPN authority.

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

NetWatch 1.0 supports **x64/AMD64 Windows 11 23H2 (build 22631) or newer**.

You need:

- WSL2 with a normal Linux distribution; Ubuntu is recommended.
- Docker Desktop using the WSL2 backend and integrated with that distribution.
- A full-tunnel WireGuard client configuration. Generic WireGuard and VPNBook profiles are supported.
- A TMDB API key.
- Prowlarr with at least one usable indexer and a 32-character API key.

Optional subtitle providers:

- OpenSubtitles: 32-character API key.
- SubDL: `subdl_` plus a 43-character key suffix. NetWatch supplies the `subdl_` prefix in the UI.

The installer can help install or enable WSL, Ubuntu, and Docker Desktop. Launch Setup normally; do not use **Run as administrator**. Only the WSL servicing step requests UAC when needed.

## First run

1. Select **Generic WireGuard** or **VPNBook** and import the provider `.conf`.
2. NetWatch verifies the VPN, DNS path, kill switch, and egress.
3. Enter the required TMDB API key. OpenSubtitles and SubDL can be skipped.
4. Configure Prowlarr and enter its API key.
5. Start NetWatch.

OpenSubtitles and SubDL can be added or replaced later in **Settings**. Settings shows only whether a key is configured; stored key values are never displayed.

NetWatch rewrites imported WireGuard profiles into its managed format. Provider command hooks are rejected, a full IPv4 tunnel (`0.0.0.0/0`) is required, and the profile must provide an IPv4 DNS resolver.

VPNBook uses the same WireGuard path as any other provider. Its profile-expiry estimate is only a reminder.

Private state is stored in the selected WSL distribution under:

```text
~/.local/share/netwatch/
```

Normal reinstall/upgrade preserves this state.

### Upgrade note

Upgrades preserve existing API credentials. Users upgrading from 1.0.4 or earlier may be asked to re-import their provider WireGuard `.conf` once because the managed firewall format changed in 1.0.5. Re-import the original provider profile rather than copying an old NetWatch-managed `wg0.conf`. Missing optional subtitle keys do not reopen first-run setup.

## Prowlarr and FlareSolverr

NetWatch uses Prowlarr as its only indexer interface. Configure indexers in Prowlarr, not in NetWatch.

For Cloudflare-protected indexers, the bundled FlareSolverr service is available to Prowlarr at:

```text
http://127.0.0.1:8191
```

Assign the same Prowlarr proxy tag to the indexers that should use it.

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
release\NetWatch-Setup-1.0.9.exe
```

Use `npm ci` for reproducible builds. See [`packaging/PACKAGING.md`](packaging/PACKAGING.md) for Windows packaging details.

## Source development

Private source-mode configuration is ignored by Git:

```text
backend/.env
docker/wireguard/wg_confs/wg0.conf
docker/prowlarr/config/
```

When running Electron from a Windows checkout, point it at the matching WSL path:

```powershell
$env:NETWATCH_WSL_DISTRO = "Ubuntu"
$env:NETWATCH_WSL_PROJECT_PATH = "/mnt/c/NetWatchBuild/netwatch"
npx electron .
```

Start the source Compose stack from WSL:

```bash
docker compose -f docker/docker-compose.yml up -d
python3 docker/verify-networking.py
```

Treat the shared VPN namespace as a unit; do not recreate only the VPN container while leaving dependent services attached to the old namespace.

## Tests

Backend:

```bash
python3 -m unittest discover -s backend -p 'test_*.py'
```

Torrent engine:

```bash
python3 -m unittest -v torrent-engine/test_engine.py
```

Remote gateway:

```powershell
npm run test:gateway
```

Android (JDK 17 and Android API 37 SDK required):

```powershell
cd android
.\gradlew.bat testDebugUnitTest assembleDebug
```


Configured-environment smoke scripts are under `backend/scripts/`. Some make real provider, indexer, or torrent requests.

## Troubleshooting

**Prerequisite setup was interrupted**  
Let any trusted Microsoft, Ubuntu, or Docker installer already running finish, then use **Refresh checks**. Do not disable endpoint protection for NetWatch.

**Prowlarr is not ready**  
Open Prowlarr, finish its setup, configure at least one indexer, and enter its API key in NetWatch.

**VPN or DNS verification fails**  
Run:

```powershell
wsl -d Ubuntu -- sh -lc 'cd ~/.local/share/netwatch/runtime && python3 docker/verify-networking.py'
```

Replace `Ubuntu` if NetWatch uses another distribution.

**The Windows host VPN changed while NetWatch was running**  
Restart NetWatch. Host-VPN changes can interrupt Docker/WSL networking.

**Packaging fails from a WSL UNC path**  
Move the checkout to Windows NTFS and rerun `npm ci` and the packaging command.

## Security and privacy

The inner WireGuard tunnel is the authoritative Internet path for NetWatch's backend services. Windows-facing services are published on loopback only, and VPN-side control ports are blocked from WireGuard peers.

A Windows host VPN can be used as an extra layer, but it does not replace the inner tunnel.

Remote Access is disabled by default. When explicitly enabled, a separate TLS gateway binds only the selected private IPv4 interface; existing backend and service ports remain loopback-only. Pairing is short-lived, Android pins the PC identity, and devices can be revoked individually. See [`docs/remote-security-model.md`](docs/remote-security-model.md) and [`remote-gateway/protocol/remote-v1.md`](remote-gateway/protocol/remote-v1.md).

NetWatch does not promise anonymity or protection from a compromised host, VPN provider, dependency, or third-party service. See [`docs/network-threat-model.md`](docs/network-threat-model.md) for the full model and [`SECURITY.md`](SECURITY.md) for vulnerability reporting.

## License

NetWatch is licensed under **GPL-3.0-only**. See [`LICENSE`](LICENSE).

Third-party components keep their own licenses. See [`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md). Bundled mpv provenance and corresponding-source details are under [`resources/mpv/`](resources/mpv/README.md).

See [`DISCLAIMER.md`](DISCLAIMER.md) for the project disclaimer.
