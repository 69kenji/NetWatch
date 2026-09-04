# Remote Access security model

NetWatch Remote Access is an opt-in LAN feature for the Android thin client. The PC remains the only torrent, provider, filesystem, and VPN authority. Turning this feature on creates one new TLS listener; it does not republish the existing backend, torrent engine, Prowlarr, or FlareSolverr ports.

## Architecture decisions

- The listener runs in an Electron utility process, separate from every renderer. It can call only the fixed loopback backend origin and approved API paths.
- It binds one selected RFC1918 IPv4 interface. A request is accepted only when the socket peer is private and belongs to that interface's subnet.
- Remote Access defaults off and has no LAN listener, health route, pairing route, or media route while disabled.
- A self-signed ECDSA P-256 identity is generated locally. Its private key is encrypted at rest with Electron `safeStorage`; plaintext exists briefly in the main process during handoff and in the utility process while enabled, never in a renderer.
- Pairing is a five-minute, user-initiated, one-time QR claim. Failed claims have per-source and per-window limits.
- Each Android device gets an independent 256-bit credential. Only its SHA-256 hash is stored on the PC. Revocation closes active responses and sessions immediately.
- Catalog IDs, opaque release references, and server-created session IDs are the only accepted media selectors. No route accepts a URL, magnet, Windows path, UNC path, or file URI.
- Backend responses are recursively minimized. Provider keys/URLs, magnets, torrent hashes, local paths, WireGuard material, and loopback service addresses are prohibited at the remote boundary.
- Artwork and subtitles use validated gateway routes. Provider URLs are never forwarded to the phone.
- The existing verified-piece range endpoint remains the media source. The gateway forwards `Range` and preserves backpressure and cancellation without buffering the movie in memory.
- The current torrent scheduler has one seek/deadline window per info hash. Protocol v1 therefore permits one Android stream per device, three globally, and one per torrent hash.
- Remote-created torrents use reference-counted leases. Cleanup happens only when the remote lease reaches zero, the add operation established remote ownership, and the Electron main process confirms the desktop player is not using that hash.

## Android boundary

The QR SPKI fingerprint is checked during the first and every later TLS handshake. Redirects are disabled, every URL is resolved under the pinned HTTPS origin, and the device credential appears only in an authorization header. The app does not use a permissive trust manager or cleartext fallback.

The device profile is encrypted with AES-GCM using a non-exportable key in Android Keystore. Shared-preference/file backup and device transfer are excluded. Unpairing revokes the PC credential when reachable and always erases the local encrypted profile.

The camera permission is used only for QR pairing. Frames are passed locally from CameraX to the bundled ML Kit barcode model and are neither stored nor uploaded. Network and camera are the only manifest permissions.

Media3 handles demuxing, embedded tracks, volume, pause/resume, seeking, and immersive landscape playback on Android. Its network data source reuses the same pinned and authenticated HTTP client. External subtitles are discovered and downloaded only through the session API, written to app-private cache, and purged when a player starts or closes.

## Fail-closed behavior

- If the selected interface disappears, startup fails and no replacement interface is chosen silently.
- If secure key encryption is unavailable or the identity cannot be decrypted, Remote Access remains disabled.
- If the protected runtime is not ready, catalog and playback creation return a generic 503.
- If a pin changes, Android rejects TLS and requires explicit re-pairing.
- If a credential is missing, malformed, random, or revoked, the gateway returns 401 without backend access.
- If the PC restarts, in-memory playback and subtitle references expire. Android reports the lost session and returns to browsing.
- Internal errors use a fixed envelope; stack traces and backend error bodies are not sent remotely.

## Threat coverage and assumptions

TLS plus SPKI pinning covers passive LAN observers and active certificate substitution. Per-device credentials, explicit short pairing, rate limits, subnet checks, and immediate revocation constrain malicious LAN peers. Origin rejection and absent CORS constrain browser-origin attacks. Fixed backend routes and strict request models prevent SSRF and filesystem selection.

The model does not protect an already compromised/unlocked PC, an already compromised/unlocked phone, a local administrator who changes firewall/network policy, malicious dependencies, or denial of service against the LAN itself. It does not claim anonymity or make third-party content trustworthy. Media remains untrusted input to Android's media stack.

## Verification still required for a release

Automated tests cover private-address/subnet rules, recursive data minimization, credential hashing, one-time pairing, invalid device names, authentication, and revocation. Existing backend tests cover verified-piece streaming and release-reference boundaries. A release candidate must additionally be exercised on a real LAN and Android device for MITM/pin replacement, malformed and far `Range` seeks, slow/abandoned clients, credential/log leakage, full-length MKV playback, track switching, background/foreground behavior, PC runtime restart, and repeated cleanup.

Packet capture and socket inspection must confirm that provider/torrent traffic still exits only through inner WireGuard, only the chosen gateway port is LAN-reachable, disabling removes that listener, and no UPnP/NAT-PMP mapping exists.
