# NetWatch Remote Protocol v1

This protocol is LAN-only and intentionally narrower than the loopback FastAPI API. The gateway binds one user-selected RFC1918 IPv4 address, rejects peers outside that interface's subnet, uses TLS 1.2 or newer, and never enables CORS. Except for the two pairing routes, every request requires `Authorization: Bearer <device credential>`.

## Pairing document

The desktop QR contains JSON:

```json
{
  "version": 1,
  "host": "192.168.1.10",
  "port": 42117,
  "pairing_secret": "base64url-24-random-bytes",
  "server_spki_sha256": "base64url-sha256-of-certificate-spki",
  "expires_at": "2026-01-01T12:05:00.000Z"
}
```

The Android client validates the private IPv4 address, protocol, field lengths, and short expiry before connecting. It pins `server_spki_sha256` on the first TLS connection; it does not temporarily disable certificate checks.

`POST /remote/v1/pair/claim` accepts the QR secret and a 1–80 character device name. A successful claim invalidates the secret and returns a random 256-bit device credential. The PC persists only its SHA-256 hash.

## Routes

Public only while pairing is active:

- `GET /remote/v1/health`
- `POST /remote/v1/pair/claim`

Authenticated catalog:

- `GET /remote/v1/status`
- `GET /remote/v1/home`
- `GET /remote/v1/discover?media=movies|tv|anime&category=popular|new|featured&genre=<id>`
- `GET /remote/v1/discover/genres?media=movies|tv|anime`
- `GET /remote/v1/search?q=<query>&page=<number>`
- `GET /remote/v1/title/{movie:id|tv:id}`
- `GET /remote/v1/title/{tv:id}/seasons`
- `GET /remote/v1/title/{tv:id}/season/{number}`
- `GET /remote/v1/title/{movie:id}/stream-options`
- `GET /remote/v1/title/{tv:id}/episode/{season}/{episode}/stream-options`
- `GET /remote/v1/artwork/{approved-size}/{filename}`

Authenticated playback:

- `POST /remote/v1/playback` with an opaque `release_ref`, catalog ID, media name, and optional episode coordinates
- `GET /remote/v1/playback/{session_id}`
- `GET|HEAD /remote/v1/playback/{session_id}/stream` with optional `Range`
- `GET /remote/v1/playback/{session_id}/tracks`
- `GET /remote/v1/playback/{session_id}/subtitles?languages=en,...`
- `POST /remote/v1/playback/{session_id}/subtitles` with a gateway-issued subtitle reference
- `GET /remote/v1/playback/{session_id}/subtitles/{subtitle_ref}`
- `DELETE /remote/v1/playback/{session_id}`

Authenticated device management:

- `DELETE /remote/v1/device/self`

Embedded audio and subtitle track selection is client-managed by Media3 because Android demuxes and renders the authenticated container stream. The gateway therefore does not expose server-side `select-audio` or `select-subtitle` operations. External subtitle discovery still uses opaque, session-bound references and authenticated content delivery.

## Errors and compatibility

Errors have one stable envelope and contain no backend detail:

```json
{ "error": { "code": "AUTH_REQUIRED", "message": "A valid paired-device credential is required" } }
```

The status and claim responses publish `protocol_min` and `protocol_max`. A client must stop and request an app update if no version overlaps. Protocol v1 does not support Internet exposure, UPnP/NAT-PMP, arbitrary URLs, arbitrary filesystem paths, downloads, or offline media.
