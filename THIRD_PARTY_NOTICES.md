# NetWatch third-party notices

NetWatch is licensed under GPL-3.0-only. Third-party software retains its own copyright and license terms.

The complete JavaScript and Python dependency graphs are recorded in `package-lock.json`, `backend/requirements.lock.txt`, and `torrent-engine/requirements.lock.txt`. This file highlights the major bundled or deliberately pinned runtime components.

## mpv — bundled Windows runtime

- Version: `mpv v0.41.0-922-gf4d13e1c2`
- Source revision: `f4d13e1c2c91f3a56e589aef9cb44cbc02e26e47`
- License of this GPL-enabled build: GPL-2.0-or-later
- Upstream: https://mpv.io/
- Source: https://github.com/mpv-player/mpv
- Windows build project: https://github.com/zhongfly/mpv-winbuild
- Matching release: `2026-08-13-f4d13e1c2c`
- Build-repository revision: `ec05635`

NetWatch ships mpv as a separate executable and controls it through JSON IPC. See [`resources/mpv/BUILD-PROVENANCE.md`](resources/mpv/BUILD-PROVENANCE.md) for exact hashes and corresponding-source requirements.

## Microsoft D3DCompiler 43 — bundled binary

- File: `d3dcompiler_43.dll`
- SHA-256: `4b074a3976399dc735484f5d43d04b519b7bdee8ac719d9ab8ed6bd4e6be0345`
- Licensor: Microsoft Corporation
- Terms: Microsoft proprietary redistributable terms; not covered by NetWatch's GPL

NetWatch ships this application-local runtime unmodified as part of the mpv runtime set.

## libtorrent

- Component: libtorrent-rasterbar / Python bindings
- License: BSD
- Upstream: https://www.libtorrent.org/
- Source: https://github.com/arvidn/libtorrent
- Acquisition: Ubuntu 24.04 `python3-libtorrent` package during torrent-engine image build

NetWatch intentionally uses Ubuntu's distro-provided native bindings rather than a PyPI replacement. Ubuntu package copyright/license metadata remains available in the built image.

## FlareSolverr

- Version: 3.5.0
- Source revision: `4ca91a24f87a73f963e1d6610cbf3b9f01c1cc1b`
- License: MIT
- Upstream: https://github.com/FlareSolverr/FlareSolverr

Compose builds this exact upstream revision from source; the source ZIP does not contain a prebuilt FlareSolverr image.

## Prowlarr / LinuxServer.io

- Image: `lscr.io/linuxserver/prowlarr:2.5.2.5491-ls156`
- Digest: `sha256:1295cff29d10b486c0d8324d1559a552140a5932bf8b3d87e398654414f63f92`
- Prowlarr license: GPL-3.0-or-later
- LinuxServer.io image repository license: GPL-3.0-only
- Application: https://github.com/Prowlarr/Prowlarr
- Image source: https://github.com/linuxserver/docker-prowlarr

The image is pulled by Docker and is not embedded in the NetWatch source ZIP.

## WireGuard / LinuxServer.io

- Image: `lscr.io/linuxserver/wireguard:1.0.20260223-r0-ls120`
- Digest: `sha256:3abfd4b82212106e357989750b9c0c9859aa511f5305a9a55c18c8de7198b655`
- Image repository license: GPL-3.0-only
- Source: https://github.com/linuxserver/docker-wireguard

The image is pulled by Docker and is not embedded in the NetWatch source ZIP.

## Electron and application dependencies

The packaged application includes Electron/Chromium/Node and JavaScript dependencies whose licenses remain their own. Electron distributions include their Chromium/open-source notices. Binary distributors must preserve notices/licenses required by all bundled dependencies.

## Trademarks

Third-party names and trademarks are used only for identification. NetWatch's license does not grant rights to third-party trademarks.
