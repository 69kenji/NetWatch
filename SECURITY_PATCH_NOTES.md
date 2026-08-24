# NetWatch 1.0.5 Security and Regression Fixes

This source archive contains the security, cleanup, and regression fixes produced
from the released NetWatch 1.0.4 codebase. This is the final NetWatch 1.0.5
release source; 1.0.4 remains the previously released version.

## Security fixes

- Keep Prowlarr provider/download URLs (including credential-bearing `apikey`
  query parameters) backend-only. Renderer search results now receive short-lived
  opaque release references that are consumed by `/api/torrents/add`.
- Pin outbound provider HTTP connections to the IP addresses that passed the SSRF
  policy, removing the DNS validation/connection time-of-check-to-time-of-use gap.
- Remove the obsolete destructive `/await-ready/{info_hash}` endpoint.
- Enforce format/length/range validation for torrent hashes, search requests, add
  requests, and torrent-engine request bodies.
- Reject direct HTTP(S) torrent sources at renderer-facing add boundaries; direct
  user/tooling input is magnet-only and provider HTTP URLs remain backend-owned.
- Give the player overlay a dedicated least-privilege preload and authorize every
  runtime/window/player IPC handler against its intended top-level renderer.
- Register a packaged `app://netwatch` origin and apply restrictive CSPs to the
  main and player renderer documents.
- Tighten backend CORS and add bounded request throttling for expensive provider
  routes. Dynamic movie/series/season and stream-option paths share normalized
  buckets so rotating through IDs cannot bypass the limiter.
- Enforce hard streaming response limits for remote torrent/subtitle/image data
  instead of checking only after full body allocation.
- Add a total-byte cap to the subtitle cache in addition to entry and TTL limits.
- Add VPN namespace INPUT rules that reject WireGuard-peer access to NetWatch's
  internal control ports while preserving loopback use.
- Document why backend/torrent-engine keep `0.0.0.0` listeners inside the shared
  namespace: Docker host-port DNAT requires namespace-interface listeners, while
  the exact `wg0` INPUT rule blocks VPN-peer access to all control ports.
- Verify effective Prowlarr/FlareSolverr application UIDs at runtime rather than
  forcing third-party images to an arbitrary Compose `user:` value.
- Make VPN/killswitch verification check the exact expected firewall and routing
  invariants rather than accepting substring matches.
- Drop all Linux capabilities and set `no-new-privileges` on NetWatch-owned
  backend/torrent-engine containers.
- Harden the elevated Windows prerequisite helper against reparse-point paths.
  Windows packaging remains usable without a code-signing certificate; unsigned
  public releases will still show the normal Windows publisher/SmartScreen warnings.
- Mark the host-side backend command explicitly unsafe for VPN/privacy testing.
- Replace fragile runtime assertions and add debug logging around intentionally
  tolerated libtorrent compatibility failures.

## Playback regression fix

- Long seeks that leave mpv's known demuxer cache now show the cinematic buffering overlay immediately and keep it visible while mpv is seeking/restarting playback. The overlay clears on mpv `playback-restart` or when the observable `seeking` state returns false. Small seeks that stay inside the known cache remain visually instant.
- During the seek-restart phase the buffering brand pulses instead of displaying a stale pre-seek 100% cache value; normal cache progress resumes once mpv actually enters `paused-for-cache`.

## Cleanup

- Removed legacy readiness/cleanup code made obsolete by playback-status polling.
- Removed unused compatibility/service helpers identified by repository-wide
  reference analysis.
- Removed obsolete renderer compatibility fields and stale architecture comments.

## Verification performed in this environment

- Node regression tests: 51 passed.
- Backend pytest suite: 53 passed (plus 4 subtests).
- Secure-config pytest suite: 28 passed (plus 7 subtests).
- Torrent-engine pytest suite: 13 passed.
- Python `compileall`: passed for backend, docker, and torrent-engine.
- Electron main/preload JavaScript syntax checks: passed.
- Windows prerequisite helper: `GOOS=windows GOARCH=amd64 go test ./...` passed;
  a clean cross-build matched the bundled patched executable byte-for-byte.
- `git diff --check`: passed.
- Docker Compose YAML parses successfully for development and packaged variants.
- Unsigned Windows packaging path: permitted; no local release certificate is required.

## Windows release signing

The patched `build/netwatch-prerequisites.exe` is reproducible but is not
Authenticode-signed because no private signing certificate was provided. A signing
certificate is **recommended** for public distribution so Windows can identify the
publisher and build reputation, but it is not required by NetWatch's build scripts.
`npm run package:dir` and `npm run package:win` work without a local certificate.

A full Vite/electron-builder rebuild was not possible in the audit environment
because `node_modules` was not included and the required npm packages were not
available in the offline npm cache. In normal release CI run `npm ci`,
`npm run build:renderer`, and then the Windows packaging command.

## Upgrade note from 1.0.4

The 1.0.5 networking hardening changes NetWatch's canonical WireGuard firewall hooks. Existing 1.0.4 API/provider credentials remain preserved, but the old managed `wg0.conf` may be rejected on first start and the user may be asked to re-import the original WireGuard `.conf` from their VPN provider. This is intentional; NetWatch does not carry compatibility code for the previous generated firewall hooks.

## Packaged runtime upgrade generation

NetWatch 1.0.5 uses runtime generation `1.0.5-pkg38`. This intentionally differs from the released 1.0.4 `1.0.4-pkg37` runtime so an in-place upgrade refreshes/rebuilds the bundled backend and torrent services. Without this generation bump, a new renderer could be paired with an old backend and stream rows would be shown without the opaque `release_ref` required to start playback. The renderer also now reports an explicit stale-runtime error instead of silently leaving such rows disabled.
