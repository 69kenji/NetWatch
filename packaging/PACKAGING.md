# NetWatch Windows packaging

This document covers the Windows build/release path. User setup belongs in the root [`README.md`](../README.md); network guarantees belong in [`docs/network-threat-model.md`](../docs/network-threat-model.md).

## Build environment

- x64/AMD64 Windows 11 23H2 (build 22631) or newer.
- Build from a normal Windows NTFS path, not `\\wsl.localhost\...`.
- Node.js `>=22.12 <23`.
- Use the committed `package-lock.json` with `npm ci`.

```powershell
npm ci
npm run package:dir
```

Test:

```text
release\win-unpacked\NetWatch.exe
```

Then build the installer:

```powershell
npm run package:win
```

For 1.0.4 the installer is:

```text
release\NetWatch-Setup-1.0.4.exe
```

## Player process model

NetWatch 1.0.3+ launches bundled `mpv.exe` directly from Electron with `child_process.spawn` using `shell: false` and `detached: true`. A separate `netwatch-surface-helper.exe` is limited to Win32 child-window discovery/show/resize operations for the existing mpv process; it cannot create processes or access the network. Ordinary playback does not invoke PowerShell, WMI scripting, `Add-Type`, or `csc.exe`.

## Installer behavior

NetWatch uses a current-user assisted NSIS installer. NetWatch itself runs as the user. Starting with 1.0.4, prerequisite bootstrap uses the project-owned `netwatch-prerequisites.exe` helper built from `native/prerequisite-helper/`; the installer no longer invokes PowerShell. Only the fixed WSL feature/package action is launched through Windows UAC when explicitly requested.

The helper writes an atomic state file with a two-second heartbeat while long WSL/Ubuntu/Docker operations run. NSIS treats 30 seconds without a heartbeat as an interruption, reports that endpoint security or another process may have terminated setup, and does not automatically reset/unregister WSL or kill remaining prerequisite installers. Ubuntu readiness also requires a non-root WSL `DefaultUid`, a matching `getent passwd` entry, and successful execution as that default user; distro registration by itself is not considered ready.

The installer can guide a clean machine through:

- enabling/updating WSL2 requirements;
- installing and initializing Ubuntu;
- installing/starting Docker Desktop;
- verifying Linux-container and per-distro Docker integration;
- choosing the NetWatch install directory and shortcuts.

NetWatch 1.0 targets x64 Windows only. Protected machine-wide install locations such as `C:\Program Files` are not a supported target for the current-user installer.

The Docker Desktop installer is fetched only from Docker's official `desktop.docker.com` HTTPS endpoint, with bounded redirects/download size. Before execution the native helper requires Windows Authenticode trust verification and a signer organization of `Docker Inc.`. Docker Desktop remains separately licensed and presents its own agreement.

## Private state

The Windows package must not contain API keys, a private WireGuard configuration, Prowlarr state, or provider credentials.

Packaged state is kept in WSL:

```text
~/.local/share/netwatch/
├── runtime/                         regenerated from the installed application
├── config/
│   ├── backend.env                 API credentials
│   ├── resolv.conf                 VPN-side DNS
│   └── wireguard/wg_confs/
│       ├── wg0.conf                active canonical WireGuard profile
│       └── wg0.pending.conf        staged replacement, when present
└── data/
    ├── vpn-profile.json            provider/reminder metadata only
    ├── vpn-profile.pending.json    staged replacement metadata, when present
    └── ...                         Prowlarr/cache/setup state
```

VPNBook provider metadata and expiry estimates contain no WireGuard key material. A replacement profile is staged with private permissions and promoted on restart before the normal VPN verification gate; the running tunnel is not hot-swapped.

Normal uninstall removes the Windows application but intentionally preserves `config/` and `data/`. It also does not uninstall Docker Desktop, disable WSL, or unregister the user's Linux distribution.

## Release checks

Before publishing an installer:

1. Build from a clean NTFS checkout with `npm ci`.
2. Test the unpacked application.
3. Build and test `NetWatch-Setup-1.0.4.exe` through install/reinstall/uninstall/reinstall, including interrupted prerequisite recovery.
4. Confirm expected WSL private state survives normal uninstall/reinstall.
5. Confirm installed resources contain the license/notices, mpv provenance, and `native/netwatch-surface-helper.exe`; no obsolete player launcher helper should be present. The prerequisite helper is installer-only and must not remain in the installed application resources.
6. Hash the source ZIP and installer.
7. Publish the GPL corresponding source/build materials required for the bundled GPL-enabled mpv runtime.

Required project release files include:

```text
LICENSE
THIRD_PARTY_NOTICES.md
DISCLAIMER.md
SECURITY.md
resources/mpv/README.md
resources/mpv/Copyright.txt
resources/mpv/LICENSE.GPL-2.0
resources/mpv/BUILD-PROVENANCE.md
```

See [`resources/mpv/BUILD-PROVENANCE.md`](../resources/mpv/BUILD-PROVENANCE.md) for the exact mpv source/build revisions and corresponding-source obligation.
