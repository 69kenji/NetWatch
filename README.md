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
    width="800"
  />
</p>

NetWatch is a Windows 11 desktop media client built with Electron/React, FastAPI, direct `python-libtorrent`, Prowlarr, WireGuard, FlareSolverr, and native Windows mpv.

Its Internet-facing services share a single Docker network namespace behind an inner WireGuard tunnel. Windows-facing APIs are exposed on loopback only, and loss of the inner VPN is designed to fail closed.

## Architecture

```text
Windows Electron / mpv
        |
        | localhost / IPC
        v
backend + torrent engine + Prowlarr + FlareSolverr
        |
        | shared VPN namespace
        v
       wg0
        |
        v
     Internet
```

## Screenshots

<p align="center">
  <img
    src="https://github.com/user-attachments/assets/04395bde-31b2-466a-b282-33bbbcc31f1c"
    alt="NetWatch Discover screen"
    width="700"
  />
</p>

<p align="center">
  <img
    src="https://github.com/user-attachments/assets/a9ab5643-5aaa-4969-b2be-a7b395531cd9"
    alt="NetWatch series details screen"
    width="700"
  />
</p>

<p align="center">
  <img
    src="https://github.com/user-attachments/assets/608c2bfa-d9cd-4afa-a5ab-53589130b4ab"
    alt="NetWatch anime catalog"
    width="700"
  />
</p>

<p align="center">
  <img
    src="https://github.com/user-attachments/assets/00689fee-27ec-42f9-94f4-2ae4d5450fce"
    alt="NetWatch player"
    width="700"
  />
</p>


For the full network/privacy model, see [`docs/network-threat-model.md`](docs/network-threat-model.md).

## Features

- Home, Discover, and unified TMDB search for movies, TV, and anime.
- Torrent discovery through Prowlarr plus a dedicated 1337x/FlareSolverr path.
- Direct libtorrent streaming with seek-aware HTTP Range scheduling.
- Native Windows mpv playback with fullscreen, seeking, audio tracks, subtitles, buffering/recovery, and live network telemetry.
- OpenSubtitles and SubDL subtitle integration.
- Inner WireGuard routing, VPN-side DNS, loopback-only host exposure, and startup network verification.

## Requirements

NetWatch 1.0 targets **x64/AMD64 Windows 11 23H2 (build 22631) or newer**. Windows Home, Pro, Enterprise, and Education are supported when the required virtualization features are available.

You will need:

- WSL2 and a normal Linux distribution; Ubuntu is recommended.
- Docker Desktop using the WSL2 backend and integrated with that distribution.
- A WireGuard client configuration from your VPN provider.
- TMDB, OpenSubtitles, and SubDL API keys.
- Prowlarr with at least one usable indexer and its API key.

The Windows installer can guide you through installing or enabling WSL, Ubuntu, and Docker Desktop when needed. Launch Setup normally; do not use **Run as administrator**.

> **TorrentDownload:** this indexer proved unreliable during 1.0 testing. Prowlarr grabs can resolve to magnets whose reported swarm counts do not reflect usable peers. Prefer another general-purpose indexer.

## First run

The packaged setup flow is:

1. Import a provider WireGuard `.conf`.
2. Verify the inner VPN, kill switch, DNS path, and real egress.
3. Enter and validate TMDB, OpenSubtitles, and SubDL API keys.
4. Configure Prowlarr and enter its API key.
5. Start NetWatch normally.

NetWatch rewrites the imported WireGuard configuration into its own canonical form. Provider command hooks are rejected, a full IPv4 tunnel (`0.0.0.0/0`) is required, and the VPN configuration must provide a usable IPv4 DNS resolver.

Secrets are stored in the selected WSL distribution under `~/.local/share/netwatch/config/`, not in the Windows application directory or source tree.

## Persistent data

Packaged state lives under:

```text
~/.local/share/netwatch/
├── runtime/                         regenerated from the installed app
├── config/
│   ├── backend.env                 API credentials
│   ├── resolv.conf                 VPN-side DNS
│   └── wireguard/wg_confs/wg0.conf
└── data/
    ├── prowlarr/
    ├── backend-cache/
    └── setup.log
```

`config/` and `data/` are preserved across normal reinstall/upgrade and are not removed by a normal NetWatch uninstall. Torrent playback data is ephemeral.

## Build from source

Build the Windows application from a normal **Windows NTFS** path such as:

```text
C:\NetWatchBuild\netwatch
```

Do not build Electron/NSIS from `\\wsl.localhost\...`.

The validated Node range is **`>=22.12 <23`**. From PowerShell:

```powershell
cd C:\NetWatchBuild\netwatch
node --version
npm ci
npm run package:dir
```

Run the unpacked build:

```text
release\win-unpacked\NetWatch.exe
```

Build the NSIS installer after validating the unpacked application:

```powershell
npm run package:win
```

The release artifact is written as:

```text
release\NetWatch-Setup-1.0.0.exe
```

Use `npm ci` for reproducible builds. Do not replace it with `npm install` and do not use `npm audit fix --force`.

For packaging/release details, see [`packaging/PACKAGING.md`](packaging/PACKAGING.md).

## Source development

Source mode expects private local configuration that is ignored by Git:

```text
backend/.env
docker/wireguard/wg_confs/wg0.conf
docker/prowlarr/config/
```

Create the first two from their `.example` files and fill them with your own credentials/configuration. Never commit real secrets.

When running Electron directly from a Windows checkout, point it at the matching WSL path:

```powershell
$env:NETWATCH_WSL_DISTRO = "Ubuntu"
$env:NETWATCH_WSL_PROJECT_PATH = "/mnt/c/NetWatchBuild/netwatch"
npx electron .
```

The source Compose stack can be started from WSL with:

```bash
docker compose -f docker/docker-compose.yml up -d
python3 docker/verify-networking.py
```

Treat the shared VPN namespace as a unit; do not recreate only the VPN container while leaving dependent services attached to an old namespace.

## Tests

Backend regression suite:

```bash
python3 -m unittest discover -s backend -p 'test_*.py'
```

Torrent-engine tests:

```bash
python3 -m unittest -v torrent-engine/test_engine.py
```

Configured-environment smoke scripts are under `backend/scripts/`. Some perform real provider/indexer/torrent operations; use only services and queries you are authorized to use.

## Diagnostics

Check the packaged containers:

```powershell
docker ps --filter "name=nw_" --format "table {{.Names}}\t{{.Status}}\t{{.Image}}"
```

Run the structural network verifier:

```powershell
wsl -d Ubuntu -- sh -lc 'cd ~/.local/share/netwatch/runtime && python3 docker/verify-networking.py'
```

Replace `Ubuntu` if NetWatch uses another distribution. A successful check ends with:

```text
Networking verification PASSED.
```

The host-facing services are intentionally loopback-only:

```text
http://127.0.0.1:8000   NetWatch backend
http://127.0.0.1:9696   Prowlarr
```

Torrent-engine and FlareSolverr are not published as independent Windows services.

## Common problems

**Docker is unavailable**  
Start Docker Desktop, confirm it is using Linux containers, and verify WSL integration:

```powershell
wsl -d Ubuntu -- docker info
```

**First-run setup does not complete**  
Relaunch NetWatch and let setup re-evaluate the real configuration. Do not move credentials into the installed Windows application directory.

**Prowlarr is not ready**  
Use **Open Prowlarr**, finish its local setup, configure at least one usable indexer, then paste its API key back into NetWatch.

**VPN/DNS verification fails**  
Run `docker/verify-networking.py`. Do not work around a failure by giving backend, torrent-engine, Prowlarr, or FlareSolverr an independent Docker egress path.

**The Windows host VPN was changed while NetWatch was running**  
Restart NetWatch. Host-VPN transitions can leave Docker/WSL networking unavailable; the validated failure mode remains fail-closed.

**Windows packaging fails from a WSL UNC path**  
Move the checkout to Windows NTFS and rerun `npm ci` / `npm run package:dir`.

## Optional Windows host VPN

A Windows host VPN may be used as defense-in-depth, but it does not replace NetWatch's inner WireGuard tunnel. When both are enabled, use different relay endpoints. If you disconnect/reconnect the host VPN or change its relay while NetWatch is running, restart NetWatch afterward.

## Security and privacy

NetWatch is designed to reduce accidental unprotected traffic from its own runtime. It does not promise anonymity, protection from a compromised host/VPN provider, legal protection, or uninterrupted third-party services.

Report vulnerabilities according to [`SECURITY.md`](SECURITY.md). Do not post credentials, private WireGuard configuration, API keys, or exploit details in a public issue.

See [`docs/network-threat-model.md`](docs/network-threat-model.md) for the network architecture, verified failure behavior, and limitations.

## License

NetWatch is licensed under **GPL-3.0-only**. See [`LICENSE`](LICENSE).

Third-party components retain their own licenses. See [`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md). The bundled GPL-enabled mpv runtime has separate provenance and corresponding-source requirements documented under [`resources/mpv/`](resources/mpv/README.md).

See [`DISCLAIMER.md`](DISCLAIMER.md) for the project disclaimer.
