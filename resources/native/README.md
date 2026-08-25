# NetWatch surface helper

`netwatch-surface-helper.exe` manages mpv's embedded child window while Electron launches mpv directly. It only finds, shows, and resizes the existing window; it cannot launch processes, elevate, run shell commands, or access the network.

## Build provenance

- Source: `native/surface-helper/`
- Target: Windows x86-64
- Go toolchain: Go 1.23.2
- CGO: disabled
- External Go modules: none
- SHA-256: `0231ebffd279ba3bc4f9075ba00220843610585986643fa7daaedc409433619c`

Build command:

```text
GOOS=windows GOARCH=amd64 CGO_ENABLED=0 go build -trimpath -buildvcs=false -ldflags "-H=windowsgui" -o resources/native/netwatch-surface-helper.exe ./native/surface-helper
```
