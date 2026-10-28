# NetWatch surface helper

`netwatch-surface-helper.exe` manages mpv's embedded child window while Electron launches mpv directly. It also exposes a constrained Windows DWM command used to extend or reset the frame of a PID-validated NetWatch window. It cannot launch processes, elevate, run shell commands, or access the network.

## Build provenance

- Source: `native/surface-helper/`
- Target: Windows x86-64
- Go toolchain: Go 1.23.2
- CGO: disabled
- External Go modules: none
- SHA-256: `9121db08a23fba4d30fa5f83655db0025450e9ad9c0600eb6b18ce9198333fd1`

Build command:

```text
GOOS=windows GOARCH=amd64 CGO_ENABLED=0 go build -trimpath -buildvcs=false -ldflags "-H=windowsgui" -o resources/native/netwatch-surface-helper.exe ./native/surface-helper
```
