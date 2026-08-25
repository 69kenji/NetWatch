# Windows packaging

This file covers the Windows build and release process. User setup is in [`README.md`](../README.md). Network/security details are in [`docs/network-threat-model.md`](../docs/network-threat-model.md).

## Build requirements

- x64/AMD64 Windows 11 23H2 (build 22631) or newer
- NTFS checkout; do not build from `\\wsl.localhost\...`
- Node.js `>=22.12 <23`
- committed `package-lock.json`

Install dependencies with:

```powershell
npm ci
```

## Build

Create an unpacked build first:

```powershell
npm run package:dir
```

Run:

```text
release\win-unpacked\NetWatch.exe
```

Then build the NSIS installer:

```powershell
npm run package:win
```

For 1.0.8:

```text
release\NetWatch-Setup-1.0.8.exe
```

## Installer behavior

NetWatch uses a current-user NSIS installer. The project-owned `netwatch-prerequisites.exe` helper handles prerequisite checks and the supported WSL/Ubuntu/Docker setup actions.

Only the WSL servicing action requests UAC. Ubuntu setup and Docker Desktop remain current-user steps.

The helper can:

- check WSL, Ubuntu, and Docker Desktop;
- enable/update the required WSL components;
- install or initialize Ubuntu;
- download, verify, and install Docker Desktop;
- start Docker Desktop.

Docker Desktop is downloaded only from `desktop.docker.com`. The download is bounded and its installer must pass Windows Authenticode verification with a Docker Inc. signer before execution.

The helper writes a heartbeat while long actions run so NSIS can detect an interrupted setup. Ubuntu is considered ready only after a normal non-root user exists and can run commands.

NetWatch 1.0 supports x64 Windows only. Protected machine-wide locations such as `C:\Program Files` are not supported by the current-user installer.

## Persistent state

The Windows package must not contain API keys, private WireGuard profiles, or Prowlarr user state.

Packaged state lives in WSL:

```text
~/.local/share/netwatch/
├── runtime/                         regenerated from the installed app
├── config/
│   ├── backend.env                 API credentials
│   ├── resolv.conf                 VPN-side DNS
│   └── wireguard/wg_confs/
│       ├── wg0.conf                active managed profile
│       └── wg0.pending.conf        staged replacement, when present
└── data/
    ├── prowlarr/
    ├── backend-cache/
    ├── vpn-profile.json
    ├── vpn-profile.pending.json
    └── setup.log
```

Normal uninstall removes the Windows app but preserves `config/` and `data/`. It does not uninstall Docker Desktop, disable WSL, or unregister the user's Linux distribution.

