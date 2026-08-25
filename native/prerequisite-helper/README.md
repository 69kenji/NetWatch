# NetWatch prerequisite helper

Windows-only helper used by the NSIS installer for WSL, Ubuntu, and Docker Desktop setup. It is installer-only and is not installed with the normal NetWatch runtime.

## Behavior

- Fixed command surface; no arbitrary shell execution.
- Does not use PowerShell, `cmd.exe`, or WMI command modes.
- Builds executable paths and arguments from fixed actions.
- Downloads Docker Desktop only from HTTPS `desktop.docker.com`, with bounded redirects and download size.
- Requires the Docker installer to pass Windows Authenticode verification with a Docker Inc. signer before execution.
- Requests UAC only for WSL servicing.
- Leaves Ubuntu account creation interactive; NetWatch does not create or store Linux passwords.
- Writes heartbeat state so NSIS can detect interrupted setup.
- Rejects Windows reparse points for helper state writes.

## Build provenance

- Source: `native/prerequisite-helper/`
- Target: Windows x86-64
- Go toolchain: Go 1.23.2
- CGO: disabled
- External Go modules: none
- SHA-256: `84214b3cbbb39bc90a8a6e7ac98bdbc7deb4b112750fec8fc5eed946a3f1d4bd`

Build from `native/prerequisite-helper/`:

```text
GOOS=windows GOARCH=amd64 CGO_ENABLED=0 go build -trimpath -buildvcs=false -o ../../build/netwatch-prerequisites.exe .
```

The checked-in helper is built with `-trimpath -buildvcs=false` so its bytes do not depend on the surrounding Git checkout. The checked-in helper is unsigned; packaging does not require a NetWatch signing certificate.

The helper uses the Windows console subsystem so WSL/DISM probes and interactive Ubuntu first-run setup receive the console handles they need. Ubuntu initialization uses native `CreateProcessW` with `CREATE_NEW_CONSOLE`.
