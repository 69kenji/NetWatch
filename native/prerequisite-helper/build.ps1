$ErrorActionPreference = "Stop"
$env:GOOS = "windows"
$env:GOARCH = "amd64"
$env:CGO_ENABLED = "0"

$Output = Join-Path $PSScriptRoot "..\..\build\netwatch-prerequisites.exe"
go build -trimpath -o $Output .

# Distributed installers must sign the elevated helper before packaging. The
# normal development build remains reproducible and unsigned unless a signing
# thumbprint is explicitly supplied.
if ($env:NETWATCH_CODESIGN_CERT_SHA1) {
    $Timestamp = if ($env:NETWATCH_CODESIGN_TIMESTAMP_URL) { $env:NETWATCH_CODESIGN_TIMESTAMP_URL } else { "http://timestamp.digicert.com" }
    & signtool.exe sign /sha1 $env:NETWATCH_CODESIGN_CERT_SHA1 /fd SHA256 /tr $Timestamp /td SHA256 $Output
    if ($LASTEXITCODE -ne 0) { throw "signtool failed signing netwatch-prerequisites.exe" }
}

if ($env:NETWATCH_RELEASE_BUILD -eq "1") {
    $Signature = Get-AuthenticodeSignature -LiteralPath $Output
    if ($Signature.Status -ne "Valid") {
        throw "Release helper must have a valid Authenticode signature (status: $($Signature.Status))."
    }
}
