$ErrorActionPreference = "Stop"
$env:GOOS = "windows"
$env:GOARCH = "amd64"
$env:CGO_ENABLED = "0"
go build -trimpath -buildvcs=false -ldflags "-H=windowsgui" -o ..\..\resources\native\netwatch-surface-helper.exe .
