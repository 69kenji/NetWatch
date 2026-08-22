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

For 1.0.0 the installer is:

```text
release\NetWatch-Setup-1.0.0.exe
```

## Installer behavior

NetWatch uses a current-user assisted NSIS installer. NetWatch itself runs as the user; narrow UAC helpers are used only for machine-level WSL feature work when explicitly requested.

The installer can guide a clean machine through:

- enabling/updating WSL2 requirements;
- installing and initializing Ubuntu;
- installing/starting Docker Desktop;
- verifying Linux-container and per-distro Docker integration;
- choosing the NetWatch install directory and shortcuts.

NetWatch 1.0 targets x64 Windows only. Protected machine-wide install locations such as `C:\Program Files` are not a supported target for the current-user installer.

The Docker Desktop installer is fetched only from Docker's official `desktop.docker.com` HTTPS endpoint, with bounded redirects/download size and Authenticode verification. Docker Desktop remains separately licensed and presents its own agreement.

## Private state

The Windows package must not contain API keys, a private WireGuard configuration, Prowlarr state, or provider credentials.

Packaged state is kept in WSL:

```text
~/.local/share/netwatch/
├── runtime/       regenerated from the installed application
├── config/        private VPN/API configuration
└── data/          persistent Prowlarr/cache/setup state
```

Normal uninstall removes the Windows application but intentionally preserves `config/` and `data/`. It also does not uninstall Docker Desktop, disable WSL, or unregister the user's Linux distribution.

For an existing development install, the optional migration helper is:

```bash
./packaging/migrate-existing-config.sh /absolute/path/to/existing/netwatch
```

It copies only from the path supplied by the user and does not search for credentials.

## Release checks

Before publishing an installer:

1. Build from a clean NTFS checkout with `npm ci`.
2. Test the unpacked application.
3. Build and test `NetWatch-Setup-1.0.0.exe` through install/reinstall/uninstall/reinstall.
4. Confirm expected WSL private state survives normal uninstall/reinstall.
5. Confirm installed resources contain the license/notices and mpv provenance files.
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
