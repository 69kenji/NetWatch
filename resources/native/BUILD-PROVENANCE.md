# NetWatch surface helper build provenance

This binary is project-owned source built from `native/surface-helper/`.

- Target: Windows x86-64
- Go toolchain: Go 1.23.2
- CGO: disabled
- External Go modules: none
- Build command: `GOOS=windows GOARCH=amd64 CGO_ENABLED=0 go build -trimpath -ldflags "-H=windowsgui" -o resources/native/netwatch-surface-helper.exe ./native/surface-helper`
- SHA-256: 0231ebffd279ba3bc4f9075ba00220843610585986643fa7daaedc409433619c

The helper only calls Win32 user32 APIs needed to locate, show, and resize mpv's existing embedded child HWND. It does not create processes, invoke PowerShell/WMI/shells, elevate, or access the network.
