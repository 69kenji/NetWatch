# NetWatch network threat model

## Goal

NetWatch services use the inner WireGuard tunnel for Internet access. If the tunnel fails, the services must lose connectivity instead of falling back to Docker or Windows egress. This protects traffic routing; it does not guarantee anonymity.

## Runtime layout

```text
Windows Electron / mpv
        |
        | localhost / IPC
        v
+---------------------------------------------+
| shared VPN network namespace                |
|                                             |
| backend         :8000                       |
| torrent-engine  :8081                       |
| Prowlarr        :9696                       |
| FlareSolverr    :8191 (when enabled)        |
|                                             |
| ordinary traffic -> wg0                     |
| wg0 peers -> control ports -> REJECT        |
+---------------------+-----------------------+
                      |
                      v
               WireGuard relay
                      |
              [optional host VPN]
                      |
                      v
                   Internet
```

Backend, torrent-engine, Prowlarr, and optional FlareSolverr share the VPN container's network namespace. None has a separate Docker egress path.

Remote Access adds an isolated TLS gateway on one selected private IPv4 address. It reaches the backend only through `127.0.0.1:8000` and does not change Docker port publication. See [`remote-security-model.md`](remote-security-model.md).

## Network controls

- Application traffic leaves the shared namespace through `wg0`.
- WireGuard transport may use the Docker interface to reach the configured relay.
- The kill switch rejects other non-local traffic outside `wg0`.
- DNS uses the IPv4 resolver supplied by the imported WireGuard profile.
- IPv6 is disabled in the VPN namespace.
- Windows publishes backend and Prowlarr only on `127.0.0.1` ports `8000` and `9696`.
- Torrent-engine and FlareSolverr are not published to Windows.
- The namespace firewall blocks WireGuard peers from control ports `8000`, `8081`, `8191`, and `9696`.
- Remote Access exposes only its selected TLS port and creates no router mappings.

Backend and torrent-engine listen on all IPv4 interfaces inside the namespace because Docker translates Windows loopback publication there. Host bindings and the namespace firewall restrict external access.

## Trusted components

### Windows application

Electron and mpv use the backend at `127.0.0.1:8000`. Loopback prevents network exposure but not access by another process in the same Windows user session. Credential windows use sandboxed renderers with narrow preload and IPC interfaces.

mpv disables references embedded in media, automatic companion-file discovery, script loading, and the external URL resolver. Ordinary embedded chapter labels and explicitly selected subtitles remain available. Linked/ordered chapters that load other files are unsupported. These controls reduce unwanted secondary requests; they are not an OS network sandbox or a guarantee against decoder vulnerabilities.

Desktop and gateway JSON responses are capped at 8 MiB during reads, with deadlines covering the body. Backend provider JSON uses caps of at most 8 MiB; provider error text is capped at 4 KiB. Subtitle downloads are not automatically retried after a failed POST.

### Installer bootstrap

During prerequisite setup, the installer may use Windows servicing tools and download Docker Desktop from `desktop.docker.com`. The helper verifies Windows Authenticode and a Docker Inc. signer. Normal application traffic still uses the VPN runtime.

### WSL and Docker

Windows, WSL2, and Docker Desktop enforce process, namespace, route, capability, and port controls. Administrator changes to these controls are outside this model.

Backend and torrent-engine run as UID 1000 with capabilities dropped and `no-new-privileges`. Prowlarr and FlareSolverr use upstream startup models. `docker/verify-networking.py` rejects a root application process.

### VPN profiles

Generic WireGuard and VPNBook profiles use the same parser, kill switch, DNS handling, routing, and verification. Provider labels and VPNBook expiry estimates affect only the UI.

Replacement profiles are staged until restart and must pass the same VPN checks before startup continues.

### External services

VPN relays, trackers, peers, indexers, metadata services, and subtitle providers are untrusted. Their availability and returned data are not guaranteed.

User-supplied `.torrent` URLs must use HTTPS. The backend resolves and pins public DNS addresses for every redirect, rejects credentials and local or private destinations, sends no Prowlarr headers, allows at most six redirects, and limits the response to 16 MiB within 30 seconds. Magnet links and downloaded torrent files enter the same VPN-bound torrent engine. Direct links are not stored.

Episode playback can query `api.introdb.app` for TV intro/outro timestamps, `api.aniskip.com` for anime timings, and `api.tiffara.com` for series content guidance. AniSkip receives the MAL installment ID from the existing AniList match, its episode number, and rounded video duration. IntroDB and Tiffara receive validated IMDb IDs and, where needed, episode numbers. No file paths or torrent names are sent. Requests use fixed HTTPS hosts, pinned public DNS answers, no redirects, timeouts, bounded responses, and a capped in-memory cache. Failures hide provider data without preventing playback; explicit video chapters remain usable. The desktop renderer never contacts these providers directly.

## Local media

Local-library scans and unmatched playback do not make metadata or torrent requests. Folders come from the native Windows picker; playback accepts an indexed file ID, rechecks its canonical path, and rejects redirected roots and paths outside the selected folder. Files are never removed by library or torrent cleanup. This is not an OS sandbox: Windows permissions and the safety of the decoder still matter.

TMDB matching is optional and requires confirmation before storing an association. Matching searches use the existing VPN backend. Confirmed catalog IDs may later be used for episode metadata. Local subtitle searches are opt-in and send the title and filename through the same backend. The local index is not published through the Android gateway.

## DNS, IPv6, and host VPNs

Setup writes the checked WireGuard resolver to `~/.local/share/netwatch/config/resolv.conf`. Services in the shared namespace use that resolver. There is no configured fallback to Windows DNS, Docker's embedded resolver, or a public resolver outside the tunnel. IPv6 stays disabled rather than using a separate protected IPv6 route.

A Windows host VPN may add another layer but does not replace NetWatch's inner tunnel. Use different relay endpoints for the two tunnels. Restart NetWatch after changing or reconnecting the host VPN because Docker and WSL networking may have changed.

## Verified behavior

Earlier runtime tests using packet capture, socket inspection, route and firewall inspection, and failure testing confirmed that:

- Windows NetWatch and mpv use local services instead of direct provider or torrent connections;
- final Internet destinations appear on `wg0`;
- the Docker interface carries WireGuard transport rather than final application destinations;
- DNS follows the protected path;
- no IPv6 bypass was observed; and
- losing `wg0`, the VPN container, or VPN DNS stops connectivity instead of enabling fallback egress.

`docker/verify-networking.py` checks the expected runtime structure. Repeat packet capture after network changes.

A separate loopback test reproduced secondary playlist requests from Windows mpv and confirmed that disabling references blocks that fixture. Earlier routing tests did not establish safety for every malicious media format.

## Limits

NetWatch does not provide anonymity, protection from a compromised host or dependency, separate trust domains for tunnels using the same VPN provider, uninterrupted service during network changes, or guarantees about third-party services.
