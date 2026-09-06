# Remote Access security model

Remote Access connects the Android client over the LAN. The PC handles torrents, providers, files, and VPN routing. Enabling it adds one TLS listener without exposing other service ports.

## PC gateway

- The listener runs outside renderers and reaches only approved paths on the fixed loopback backend.
- It binds to one selected private IPv4 interface. Clients must have a private address on the same subnet.
- Remote Access is off by default. When disabled, no LAN routes are available.
- The PC creates an ECDSA P-256 identity. Electron `safeStorage` encrypts its private key, which is never sent to a renderer.
- Pairing requires a user-created QR code that expires after five minutes and can be claimed once. Failed claims are rate-limited.
- Each phone receives a 256-bit credential. The PC stores its SHA-256 hash. Revocation closes that phone's responses and sessions.
- Requests identify media with catalog IDs, opaque release references, and server-created session IDs. URLs, magnets, local paths, UNC paths, and file URIs are rejected.
- Responses remove provider URLs and keys, torrent details, local paths, WireGuard data, and loopback service addresses.
- Artwork and subtitles pass through fixed gateway routes. Provider URLs are not sent to Android.
- Video uses verified-piece range streaming with backpressure and cancellation.
- Protocol v1 allows one Android stream per phone, three total streams, and one stream per torrent hash because each hash has one seek/deadline window.
- Remote torrents use reference-counted leases and are removed only when the last lease closes and the desktop player is not using the hash.

## Android client

Android checks the QR fingerprint on every TLS handshake. Redirects are disabled, URLs stay under the paired HTTPS origin, and credentials appear only in the authorization header. There is no cleartext or permissive TLS fallback.

The pairing profile is encrypted with AES-GCM using a non-exportable Android Keystore key. Backups and device transfer are disabled. Unpairing attempts to revoke the PC credential, then removes the local profile.

Camera access is limited to QR pairing. CameraX sends frames to the on-device ML Kit scanner without saving or uploading them.

Media3 handles playback and uses the same pinned HTTP client. External subtitles come through the playback-session API, are written to application-private cache, and are removed when playback starts or closes.

## Failure handling

- Losing the selected network interface disables the listener instead of selecting another interface.
- Failure to encrypt or decrypt the PC identity keeps Remote Access disabled.
- An unavailable protected runtime returns a generic 503 for catalog and playback creation.
- A changed TLS fingerprint requires pairing again.
- Missing, malformed, unknown, or revoked credentials return 401 before backend access.
- Playback and subtitle references expire when the PC restarts.
- Remote errors use fixed response bodies without stack traces or backend details.

## Coverage and limits

TLS pinning protects against LAN monitoring and certificate substitution. Short pairing, separate credentials, rate limits, subnet checks, and revocation restrict other LAN devices. Browser-origin rejection limits browser attacks. Fixed routes prevent arbitrary URL and filesystem access.

This model does not protect a compromised or unlocked PC or phone, administrator changes to firewall or network policy, malicious dependencies, or LAN denial of service. It does not provide anonymity or make downloaded media trustworthy.

## Release checks

Test each release candidate on a real LAN and Android device. Cover fingerprint changes, malformed and distant range seeks, abandoned clients, credential leakage, long playback, track switching, app transitions, runtime restarts, and torrent cleanup.

Packet capture and socket inspection should confirm that provider and torrent traffic exits only through the inner WireGuard tunnel, only the selected gateway port is reachable from the LAN, disabling Remote Access removes the listener, and no UPnP or NAT-PMP mapping exists.
