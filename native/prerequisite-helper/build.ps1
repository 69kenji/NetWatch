$ErrorActionPreference = "Stop"
$env:GOOS = "windows"
$env:GOARCH = "amd64"
$env:CGO_ENABLED = "0"

$Output = Join-Path $PSScriptRoot "..\..\build\netwatch-prerequisites.exe"
go build -trimpath -buildvcs=false -o $Output .
