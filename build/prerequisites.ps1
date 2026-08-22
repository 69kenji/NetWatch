param(
    [ValidateSet('Probe', 'InstallOrUpdateWsl', 'InstallOrUpdateWslElevated', 'InstallUbuntu', 'InitializeDistro', 'InstallDocker', 'StartDocker')]
    [string]$Action = 'Probe',

    [Parameter(Mandatory = $true)]
    [string]$StatePath
)

Set-StrictMode -Version 2.0
$ErrorActionPreference = 'Stop'

$MinimumWslVersion = [version]'2.1.5'
$DockerDownloadUrl = 'https://desktop.docker.com/win/main/amd64/Docker%20Desktop%20Installer.exe'
$MaximumDockerInstallerBytes = 1610612736 # 1.5 GiB hard cap for the streamed installer.
$LowSystemDriveWarningGiB = 10

function Remove-Newlines([object]$Value) {
    return ([string]$Value).Replace("`r", ' ').Replace("`n", ' ').Trim()
}

function Invoke-CapturedProcess {
    param(
        [Parameter(Mandatory = $true)][string]$FilePath,
        [string[]]$Arguments = @(),
        [int]$TimeoutMs = 10000
    )

    if (-not (Test-Path -LiteralPath $FilePath -PathType Leaf)) {
        return [pscustomobject]@{ ExitCode = 9009; StdOut = ''; StdErr = 'Executable not found.'; TimedOut = $false }
    }

    # Every caller below supplies fixed tokens. Distro names are separately
    # restricted to a conservative character set before they are used here.
    foreach ($argument in $Arguments) {
        if ([string]$argument -match '[\r\n\"]') {
            throw 'Unsafe process argument.'
        }
    }

    $startInfo = New-Object System.Diagnostics.ProcessStartInfo
    $startInfo.FileName = $FilePath
    $startInfo.Arguments = ($Arguments -join ' ')
    $startInfo.UseShellExecute = $false
    $startInfo.CreateNoWindow = $true
    $startInfo.RedirectStandardOutput = $true
    $startInfo.RedirectStandardError = $true

    $process = New-Object System.Diagnostics.Process
    $process.StartInfo = $startInfo
    [void]$process.Start()
    $stdoutTask = $process.StandardOutput.ReadToEndAsync()
    $stderrTask = $process.StandardError.ReadToEndAsync()

    if (-not $process.WaitForExit($TimeoutMs)) {
        try { $process.Kill() } catch { }
        return [pscustomobject]@{ ExitCode = 1460; StdOut = ''; StdErr = 'Process timed out.'; TimedOut = $true }
    }

    return [pscustomobject]@{
        ExitCode = $process.ExitCode
        StdOut = (($stdoutTask.Result -replace "`0", '').Trim())
        StdErr = (($stderrTask.Result -replace "`0", '').Trim())
        TimedOut = $false
    }
}


function Get-NativeSystemExecutable {
    param([Parameter(Mandatory = $true)][string]$Name)
    if ($Name -notmatch '^[A-Za-z0-9._-]{1,64}$') { return '' }
    $base = $(if ([Environment]::Is64BitOperatingSystem -and -not [Environment]::Is64BitProcess) {
        Join-Path $env:WINDIR 'Sysnative'
    } else {
        Join-Path $env:WINDIR 'System32'
    })
    $candidate = Join-Path $base $Name
    if (Test-Path -LiteralPath $candidate -PathType Leaf) { return $candidate }
    return ''
}

function Get-WslExecutable {
    $candidates = @()
    if ([Environment]::Is64BitOperatingSystem -and -not [Environment]::Is64BitProcess) {
        $candidates += (Join-Path $env:WINDIR 'Sysnative\wsl.exe')
    }
    $candidates += (Join-Path $env:WINDIR 'System32\wsl.exe')
    foreach ($candidate in $candidates) {
        if (Test-Path -LiteralPath $candidate -PathType Leaf) { return $candidate }
    }
    return ''
}

function Get-WslCommandPath {
    $existing = Get-WslExecutable
    if ($existing) { return $existing }
    if ([Environment]::Is64BitOperatingSystem -and -not [Environment]::Is64BitProcess) {
        return (Join-Path $env:WINDIR 'Sysnative\wsl.exe')
    }
    return (Join-Path $env:WINDIR 'System32\wsl.exe')
}

function Get-DockerDesktopExecutable {
    $candidates = @()
    if ($env:LOCALAPPDATA) { $candidates += (Join-Path $env:LOCALAPPDATA 'Programs\DockerDesktop\Docker Desktop.exe') }
    if ($env:ProgramFiles) { $candidates += (Join-Path $env:ProgramFiles 'Docker\Docker\Docker Desktop.exe') }
    if (${env:ProgramW6432}) { $candidates += (Join-Path ${env:ProgramW6432} 'Docker\Docker\Docker Desktop.exe') }

    foreach ($candidate in ($candidates | Select-Object -Unique)) {
        if (Test-Path -LiteralPath $candidate -PathType Leaf) { return $candidate }
    }
    return ''
}

function Get-DockerCliExecutable {
    $candidates = @()
    if ($env:LOCALAPPDATA) { $candidates += (Join-Path $env:LOCALAPPDATA 'Programs\DockerDesktop\resources\bin\docker.exe') }
    if ($env:ProgramFiles) { $candidates += (Join-Path $env:ProgramFiles 'Docker\Docker\resources\bin\docker.exe') }
    if (${env:ProgramW6432}) { $candidates += (Join-Path ${env:ProgramW6432} 'Docker\Docker\resources\bin\docker.exe') }

    try {
        $command = Get-Command docker.exe -ErrorAction Stop
        if ($command -and $command.Source) { $candidates += $command.Source }
    } catch { }

    foreach ($candidate in ($candidates | Select-Object -Unique)) {
        if (Test-Path -LiteralPath $candidate -PathType Leaf) { return $candidate }
    }
    return ''
}

function Get-NormalWslDistros {
    $registryItems = @{}
    $root = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Lxss'
    if (Test-Path -LiteralPath $root) {
        foreach ($key in (Get-ChildItem -LiteralPath $root -ErrorAction SilentlyContinue)) {
            try {
                $item = Get-ItemProperty -LiteralPath $key.PSPath -ErrorAction Stop
                $name = [string]$item.DistributionName
                if (-not $name -or $name -match '^docker-desktop(?:-data)?$') { continue }
                # The Electron runtime also obtains distro names from wsl.exe. Keep
                # the accepted set intentionally conservative before later process use.
                if ($name -notmatch '^[A-Za-z0-9._-]{1,64}$') { continue }
                $registryItems[$name.ToLowerInvariant()] = [pscustomobject]@{ Name = $name; Version = [int]$item.Version }
            } catch { }
        }
    }

    if (-not $registryItems.Count) { return @() }

    # Match electron/main.js selection semantics: prefer exact Ubuntu, then an
    # Ubuntu-* distro, otherwise the first normal distro returned by `wsl -l -q`.
    $orderedNames = New-Object System.Collections.Generic.List[string]
    $wslExe = Get-WslExecutable
    if ($wslExe) {
        $listResult = Invoke-CapturedProcess -FilePath $wslExe -Arguments @('-l', '-q') -TimeoutMs 10000
        if ($listResult.ExitCode -eq 0) {
            foreach ($line in ($listResult.StdOut -split "`n")) {
                $name = $line.Trim().Trim([char]0)
                if (-not $name -or $name -match '^docker-desktop(?:-data)?$' -or $name -notmatch '^[A-Za-z0-9._-]{1,64}$') { continue }
                if ($registryItems.ContainsKey($name.ToLowerInvariant())) { [void]$orderedNames.Add($name) }
            }
        }
    }

    foreach ($entry in $registryItems.Values) {
        if (-not ($orderedNames -contains $entry.Name)) { [void]$orderedNames.Add($entry.Name) }
    }

    $preferred = New-Object System.Collections.Generic.List[string]
    $exactUbuntu = @($orderedNames | Where-Object { $_ -ieq 'Ubuntu' } | Select-Object -First 1)
    if ($exactUbuntu.Count) { [void]$preferred.Add($exactUbuntu[0]) }
    $ubuntuPrefix = @($orderedNames | Where-Object { $_ -imatch '^Ubuntu-' -and $_ -ine 'Ubuntu' } | Select-Object -First 1)
    if ($ubuntuPrefix.Count -and -not ($preferred -contains $ubuntuPrefix[0])) { [void]$preferred.Add($ubuntuPrefix[0]) }
    foreach ($name in $orderedNames) {
        if (-not ($preferred -contains $name)) { [void]$preferred.Add($name) }
    }

    $result = @()
    foreach ($name in $preferred) {
        $result += $registryItems[$name.ToLowerInvariant()]
    }
    return $result
}

function Test-DistroReady {
    param([string]$WslExe, [string]$DistroName)
    if (-not $WslExe -or -not $DistroName) { return $false }
    $result = Invoke-CapturedProcess -FilePath $WslExe -Arguments @('-d', $DistroName, '--', 'true') -TimeoutMs 8000
    return ($result.ExitCode -eq 0)
}

function Test-WindowsOptionalFeatureEnabled {
    param([Parameter(Mandatory = $true)][string]$Name)
    try {
        # Win32_OptionalFeature is readable without elevation. InstallState=1 is Enabled.
        $feature = Get-CimInstance -ClassName Win32_OptionalFeature -Filter "Name='$Name'" -ErrorAction Stop
        return ($null -ne $feature -and [int]$feature.InstallState -eq 1)
    } catch {
        return $false
    }
}

function Test-IsAdministrator {
    try {
        $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
        $principal = New-Object Security.Principal.WindowsPrincipal($identity)
        return $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
    } catch {
        return $false
    }
}

function Get-VirtualizationStatus {
    param([bool]$VirtualMachinePlatformEnabled = $false)

    $hardwareAvailable = $false
    $runningInVm = $false
    $hypervisorPresent = $false
    try {
        $computer = Get-CimInstance -ClassName Win32_ComputerSystem -ErrorAction Stop
        $hypervisorPresent = [bool]$computer.HypervisorPresent
        $vmIdentity = ([string]$computer.Manufacturer + ' ' + [string]$computer.Model)
        $runningInVm = ($vmIdentity -match '(?i)VirtualBox|VMware|Virtual Machine|KVM|QEMU|Parallels|Xen')

        $processors = @(Get-CimInstance -ClassName Win32_Processor -ErrorAction Stop)
        foreach ($processor in $processors) {
            # WSL2 requires the CPU virtualization extensions plus SLAT. Requiring
            # all three properties avoids the false-positive we observed in a VM
            # that exposed a firmware flag but could not actually host nested WSL2.
            if ($processor.VirtualizationFirmwareEnabled -and $processor.VMMonitorModeExtensions -and $processor.SecondLevelAddressTranslationExtensions) {
                $hardwareAvailable = $true
                break
            }
        }

        # Once a Microsoft hypervisor is already active on physical Windows, the
        # processor firmware properties can be masked. HypervisorPresent is an
        # acceptable positive signal on bare metal, but not inside another VM.
        if (-not $hardwareAvailable -and -not $runningInVm -and $VirtualMachinePlatformEnabled -and $hypervisorPresent) {
            $hardwareAvailable = $true
        }
    } catch { }

    $hypervisorLaunchEnabled = $true
    try {
        $bcdedit = Get-NativeSystemExecutable -Name 'bcdedit.exe'
        $bcd = Invoke-CapturedProcess -FilePath $bcdedit -Arguments @('/enum', '{current}') -TimeoutMs 10000
        if ($bcd.ExitCode -eq 0 -and (($bcd.StdOut + "`n" + $bcd.StdErr) -match '(?im)^hypervisorlaunchtype\s+off\s*$')) {
            $hypervisorLaunchEnabled = $false
        }
    } catch { }

    # Before a WSL2 distro exists there is no fully reliable, side-effect-free
    # way to prove nested virtualization from every hypervisor. Hyper-V can mask
    # the Win32_Processor virtualization flags once its hypervisor is active,
    # while some third-party VM platforms can report similar firmware signals
    # even though nested WSL2 later fails. Treat either explicit CPU capability
    # or an already-running Microsoft hypervisor as sufficient to *attempt* the
    # first WSL2 distro. Actual WSL2 execution remains the authoritative gate and
    # is proven only by successfully starting the distro.
    $preDistroGateAvailable = ($hardwareAvailable -or $hypervisorPresent)

    return [pscustomobject]@{
        HardwareAvailable = $hardwareAvailable
        PreDistroGateAvailable = $preDistroGateAvailable
        RunningInVm = $runningInVm
        HypervisorPresent = $hypervisorPresent
        HypervisorLaunchEnabled = $hypervisorLaunchEnabled
    }
}

function Get-SystemDriveFreeGiB {
    try {
        $systemRoot = [System.IO.Path]::GetPathRoot($env:SystemRoot)
        $drive = New-Object System.IO.DriveInfo($systemRoot)
        return [math]::Round(($drive.AvailableFreeSpace / 1GB), 1)
    } catch {
        return -1
    }
}

function Get-WslFailureMessage {
    param(
        [string]$Output,
        [string]$DefaultMessage
    )
    $value = ([string]$Output).Replace("`0", ' ')
    if ($value -match '(?i)HCS_E_HYPERV_NOT_INSTALLED|0x80370102|virtualization is not enabled|Virtual Machine Platform') {
        return 'WSL2 could not start its virtualization environment. Verify Virtual Machine Platform, hardware virtualization, and nested virtualization if Windows is itself running in a VM.'
    }
    if ($value -match '(?i)0x80070070|not enough (?:disk )?space|insufficient (?:disk )?space|disk is full') {
        return 'Windows reported insufficient disk space while installing the WSL distribution. Free space on the Windows system drive or use the official WSL installation tools to choose another distro location.'
    }
    if ($value -match '(?i)0x8000ffff') {
        return 'Windows reported an unexpected WSL installation failure (0x8000FFFF). Restart Windows, update WSL, and retry; the Microsoft WSL instructions button has the official troubleshooting path.'
    }
    return $DefaultMessage
}

function Get-CurrentBootId {
    try {
        $os = Get-CimInstance -ClassName Win32_OperatingSystem -ErrorAction Stop
        if ($os -and $os.LastBootUpTime) {
            return ([datetime]$os.LastBootUpTime).ToUniversalTime().Ticks.ToString([Globalization.CultureInfo]::InvariantCulture)
        }
    } catch { }
    return ''
}

function Test-NetWatchRebootPending {
    param([string]$CurrentBootId)

    # Only a reboot explicitly requested by NetWatch prerequisite changes is a
    # hard gate. Generic Windows Update/CBS/PendingFileRenameOperations flags can
    # legitimately persist on otherwise healthy machines and previously caused an
    # endless "Restart Windows" loop. Actual WSL/Docker capability probes remain
    # authoritative for unrelated machine state.
    $key = 'HKCU:\Software\NetWatch\Installer'
    try {
        $item = Get-ItemProperty -LiteralPath $key -Name 'RebootRequiredBootId' -ErrorAction SilentlyContinue
        $requestedBootId = if ($item) { [string]$item.RebootRequiredBootId } else { '' }
        if (-not $requestedBootId) { return $false }

        if ($CurrentBootId -and $requestedBootId -ne $CurrentBootId) {
            Remove-ItemProperty -LiteralPath $key -Name 'RebootRequiredBootId' -ErrorAction SilentlyContinue
            return $false
        }

        return [bool]$CurrentBootId
    } catch {
        return $false
    }
}

function Get-PrerequisiteStatus {
    $wslFeatureEnabled = Test-WindowsOptionalFeatureEnabled -Name 'Microsoft-Windows-Subsystem-Linux'
    $virtualMachinePlatformEnabled = Test-WindowsOptionalFeatureEnabled -Name 'VirtualMachinePlatform'
    $virtualization = Get-VirtualizationStatus -VirtualMachinePlatformEnabled:$virtualMachinePlatformEnabled

    $wslExe = Get-WslExecutable
    $wslPresent = [bool]$wslExe
    $wslVersionText = ''
    $wslVersionOk = $false
    $wslCommandReady = $false

    if ($wslPresent) {
        $versionResult = Invoke-CapturedProcess -FilePath $wslExe -Arguments @('--version') -TimeoutMs 10000
        $combined = (($versionResult.StdOut + "`n" + $versionResult.StdErr) -replace "`0", '')
        $versionMatch = [regex]::Match($combined, '(?m)(\d+\.\d+\.\d+(?:\.\d+)?)')
        if ($versionMatch.Success) {
            $wslVersionText = $versionMatch.Groups[1].Value
            try { $wslVersionOk = ([version]$wslVersionText -ge $MinimumWslVersion) } catch { $wslVersionOk = $false }
        } else {
            $wslVersionText = 'legacy/inbox'
        }

        $statusResult = Invoke-CapturedProcess -FilePath $wslExe -Arguments @('--status') -TimeoutMs 10000
        $wslCommandReady = ($statusResult.ExitCode -eq 0)
    }

    $bootId = Get-CurrentBootId
    $rebootPending = Test-NetWatchRebootPending -CurrentBootId $bootId
    $wslPlatformReady = ($wslFeatureEnabled -and $virtualMachinePlatformEnabled -and $wslVersionOk -and $wslCommandReady -and $virtualization.PreDistroGateAvailable -and $virtualization.HypervisorLaunchEnabled -and -not $rebootPending)

    $distros = @(Get-NormalWslDistros)
    $wsl2Distros = @($distros | Where-Object { $_.Version -eq 2 })
    $distroInstalled = ($wsl2Distros.Count -gt 0)
    $distroName = ''
    $distroReady = $false
    foreach ($distro in $wsl2Distros) {
        if (Test-DistroReady -WslExe $wslExe -DistroName $distro.Name) {
            $distroName = $distro.Name
            $distroReady = $true
            break
        }
        if (-not $distroName) { $distroName = $distro.Name }
    }

    # A WSL2 runtime can only be proven by actually starting a WSL2 distro. Before
    # the first distro exists, the installer deliberately reports the platform as
    # prepared rather than claiming that runtime execution has been verified.
    $wslRuntimeUsable = $distroReady

    $dockerDesktopExe = Get-DockerDesktopExecutable
    $dockerCli = Get-DockerCliExecutable
    $dockerInstalled = [bool]$dockerDesktopExe
    $dockerEngineReady = $false
    $dockerOsType = ''
    $dockerOperatingSystem = ''
    $dockerDesktopEngine = $false
    if ($dockerCli) {
        $dockerResult = Invoke-CapturedProcess -FilePath $dockerCli -Arguments @('info', '--format', '{{.OSType}}|{{.OperatingSystem}}') -TimeoutMs 10000
        if ($dockerResult.ExitCode -eq 0) {
            $dockerParts = @($dockerResult.StdOut.Trim() -split '\|', 2)
            if ($dockerParts.Count -ge 1) { $dockerOsType = $dockerParts[0].Trim().ToLowerInvariant() }
            if ($dockerParts.Count -ge 2) { $dockerOperatingSystem = $dockerParts[1].Trim() }
            $dockerEngineReady = [bool]$dockerOsType
            $dockerDesktopEngine = ($dockerOperatingSystem -match '(?i)Docker Desktop')
        }
    }

    $dockerWslIntegrationReady = $false
    if ($distroReady -and $wslExe -and $dockerEngineReady -and $dockerOsType -eq 'linux' -and $dockerDesktopEngine) {
        # The Windows-side probe above already proves that the active engine is
        # Docker Desktop and that it is serving Linux containers. For WSL
        # integration, the only additional property NetWatch needs is that the
        # exact distro selected by the runtime can reach that engine.
        #
        # Keep this deliberately identical to the user-facing/manual diagnostic:
        #     wsl -d <distro> -- docker info
        #
        # Do not add a second --format expression here. That made the integration
        # probe more brittle than the runtime requirement and produced a false
        # negative even while `wsl -d Ubuntu -- docker info` worked normally.
        $integrationResult = Invoke-CapturedProcess -FilePath $wslExe -Arguments @('-d', $distroName, '--', 'docker', 'info') -TimeoutMs 20000
        if ($integrationResult.ExitCode -eq 0) {
            $dockerWslIntegrationReady = $true
        }
    }

    $systemDriveFreeGiB = Get-SystemDriveFreeGiB
    $systemDriveLow = ($systemDriveFreeGiB -ge 0 -and $systemDriveFreeGiB -lt $LowSystemDriveWarningGiB)

    return [ordered]@{
        ProbeOk = '1'
        # VirtualizationOk is the conservative pre-distro gate. HardwareVirtualizationOk
        # records whether the CPU flags themselves were visible. In a nested Hyper-V
        # guest those flags may be masked while HypervisorPresent is still a valid
        # reason to allow the authoritative WSL2 runtime test to proceed.
        VirtualizationOk = $(if ($virtualization.PreDistroGateAvailable) { '1' } else { '0' })
        HardwareVirtualizationOk = $(if ($virtualization.HardwareAvailable) { '1' } else { '0' })
        HypervisorLaunchOk = $(if ($virtualization.HypervisorLaunchEnabled) { '1' } else { '0' })
        RunningInVm = $(if ($virtualization.RunningInVm) { '1' } else { '0' })
        WslFeatureEnabled = $(if ($wslFeatureEnabled) { '1' } else { '0' })
        VirtualMachinePlatformEnabled = $(if ($virtualMachinePlatformEnabled) { '1' } else { '0' })
        WslPresent = $(if ($wslPresent) { '1' } else { '0' })
        WslVersion = $wslVersionText
        WslVersionOk = $(if ($wslVersionOk) { '1' } else { '0' })
        WslCommandReady = $(if ($wslCommandReady) { '1' } else { '0' })
        WslPlatformReady = $(if ($wslPlatformReady) { '1' } else { '0' })
        WslRuntimeUsable = $(if ($wslRuntimeUsable) { '1' } else { '0' })
        DistroInstalled = $(if ($distroInstalled) { '1' } else { '0' })
        DistroReady = $(if ($distroReady) { '1' } else { '0' })
        DistroName = $distroName
        DockerInstalled = $(if ($dockerInstalled) { '1' } else { '0' })
        DockerEngineReady = $(if ($dockerEngineReady) { '1' } else { '0' })
        DockerOsType = $dockerOsType
        DockerOperatingSystem = $dockerOperatingSystem
        DockerDesktopEngine = $(if ($dockerDesktopEngine) { '1' } else { '0' })
        DockerWslIntegrationReady = $(if ($dockerWslIntegrationReady) { '1' } else { '0' })
        RebootPending = $(if ($rebootPending) { '1' } else { '0' })
        BootId = $bootId
        SystemDriveFreeGiB = $systemDriveFreeGiB
        SystemDriveLow = $(if ($systemDriveLow) { '1' } else { '0' })
    }
}

function Write-StateFile {
    param(
        [Parameter(Mandatory = $true)][System.Collections.IDictionary]$Status,
        [Parameter(Mandatory = $true)][System.Collections.IDictionary]$ActionResult
    )

    $parent = Split-Path -Parent $StatePath
    if ($parent -and -not (Test-Path -LiteralPath $parent)) { New-Item -ItemType Directory -Path $parent -Force | Out-Null }
    $temporary = "$StatePath.tmp"
    $lines = New-Object System.Collections.Generic.List[string]
    [void]$lines.Add('[Status]')
    foreach ($key in $Status.Keys) { [void]$lines.Add("$key=$(Remove-Newlines $Status[$key])") }
    [void]$lines.Add('')
    [void]$lines.Add('[Action]')
    foreach ($key in $ActionResult.Keys) { [void]$lines.Add("$key=$(Remove-Newlines $ActionResult[$key])") }
    [System.IO.File]::WriteAllLines($temporary, $lines, ([System.Text.UTF8Encoding]::new($false)))
    Move-Item -LiteralPath $temporary -Destination $StatePath -Force
}

function Enable-WslPlatformElevated {
    if (-not (Test-IsAdministrator)) {
        return [ordered]@{ Success = '0'; Code = 'WSL_ELEVATION_REQUIRED'; Message = 'Administrator approval is required to enable the Windows WSL features.'; RebootRequired = '0' }
    }

    $beforeWslFeature = Test-WindowsOptionalFeatureEnabled -Name 'Microsoft-Windows-Subsystem-Linux'
    $beforeVmpFeature = Test-WindowsOptionalFeatureEnabled -Name 'VirtualMachinePlatform'
    $featuresChanged = (-not $beforeWslFeature -or -not $beforeVmpFeature)
    $restartRequired = $false

    $dism = Get-NativeSystemExecutable -Name 'dism.exe'
    foreach ($feature in @('Microsoft-Windows-Subsystem-Linux', 'VirtualMachinePlatform')) {
        if (Test-WindowsOptionalFeatureEnabled -Name $feature) { continue }
        $result = Invoke-CapturedProcess -FilePath $dism -Arguments @('/Online', '/Enable-Feature', "/FeatureName:$feature", '/All', '/NoRestart') -TimeoutMs 180000
        if ($result.ExitCode -eq 3010) { $restartRequired = $true }
        elseif ($result.ExitCode -ne 0) {
            return [ordered]@{ Success = '0'; Code = 'WSL_FEATURE_ENABLE_FAILED'; Message = "Windows could not enable the required WSL feature $feature (exit $($result.ExitCode))."; RebootRequired = '0' }
        }
    }

    # Feature enablement is a machine-level change. Do not immediately pile a WSL
    # package operation on top of newly enabled virtualization components: force a
    # clean reboot boundary, then re-probe and continue the package update on the
    # next explicit click. This avoids half-enabled WSL2 states on clean machines.
    if ($featuresChanged) {
        return [ordered]@{
            Success = '1'
            Code = 'WSL_FEATURES_ENABLED'
            Message = 'The Windows Subsystem for Linux and Virtual Machine Platform features were enabled. Restart Windows before continuing WSL setup.'
            RebootRequired = '1'
        }
    }

    $wslExe = Get-WslCommandPath
    $versionResult = Invoke-CapturedProcess -FilePath $wslExe -Arguments @('--version') -TimeoutMs 10000
    $combined = (($versionResult.StdOut + "`n" + $versionResult.StdErr) -replace "`0", '')
    $versionMatch = [regex]::Match($combined, '(?m)(\d+\.\d+\.\d+(?:\.\d+)?)')

    if ($versionMatch.Success) {
        $wslResult = Invoke-CapturedProcess -FilePath $wslExe -Arguments @('--update', '--web-download') -TimeoutMs 600000
    } else {
        # Install/update Microsoft's current WSL package without silently adding a
        # distribution. --web-download avoids depending on Microsoft Store policy.
        $wslResult = Invoke-CapturedProcess -FilePath $wslExe -Arguments @('--install', '--no-distribution', '--web-download') -TimeoutMs 600000
    }

    if ($wslResult.ExitCode -eq 3010) { $restartRequired = $true }
    elseif ($wslResult.ExitCode -ne 0) {
        $message = Get-WslFailureMessage -Output ($wslResult.StdOut + "`n" + $wslResult.StdErr) -DefaultMessage "The Microsoft WSL package install/update failed (exit $($wslResult.ExitCode))."
        return [ordered]@{ Success = '0'; Code = 'WSL_PACKAGE_FAILED'; Message = $message; RebootRequired = '0' }
    }

    if (-not $restartRequired) {
        $defaultResult = Invoke-CapturedProcess -FilePath $wslExe -Arguments @('--set-default-version', '2') -TimeoutMs 30000
        if ($defaultResult.ExitCode -ne 0) {
            $message = Get-WslFailureMessage -Output ($defaultResult.StdOut + "`n" + $defaultResult.StdErr) -DefaultMessage 'WSL was installed, but Windows could not set WSL 2 as the default version.'
            return [ordered]@{ Success = '0'; Code = 'WSL_DEFAULT_VERSION_FAILED'; Message = $message; RebootRequired = '0' }
        }
    }

    return [ordered]@{
        Success = '1'
        Code = 'WSL_PLATFORM_ENABLED'
        Message = $(if ($restartRequired) { 'The WSL package was installed or updated. Restart Windows before installing Ubuntu.' } else { 'WSL 2 and its required Windows features are ready.' })
        RebootRequired = $(if ($restartRequired) { '1' } else { '0' })
    }
}

function Install-OrUpdateWsl {
    # The normal-user helper never attempts to self-elevate. The NSIS installer
    # owns the UAC boundary and launches InstallOrUpdateWslElevated directly via
    # ShellExecute("runas"). Keeping elevation out of nested PowerShell avoids
    # UAC failures when the helper itself is running hidden/noninteractive.
    if (-not (Test-IsAdministrator)) {
        return [ordered]@{ Success = '0'; Code = 'WSL_ELEVATION_REQUIRED'; Message = 'Administrator approval is required for the Windows WSL operation.'; RebootRequired = '0' }
    }
    return Enable-WslPlatformElevated
}

function Install-Ubuntu {
    $status = Get-PrerequisiteStatus
    if ($status.WslFeatureEnabled -ne '1' -or $status.VirtualMachinePlatformEnabled -ne '1') {
        return [ordered]@{ Success = '0'; Code = 'DISTRO_WSL_FEATURES_NOT_READY'; Message = 'Enable the Windows Subsystem for Linux and Virtual Machine Platform features before installing Ubuntu.'; RebootRequired = '0' }
    }
    if ($status.RebootPending -eq '1') {
        return [ordered]@{ Success = '0'; Code = 'DISTRO_REBOOT_REQUIRED'; Message = 'Windows has pending prerequisite changes. Restart Windows before installing Ubuntu.'; RebootRequired = '1' }
    }
    if ($status.VirtualizationOk -ne '1' -or $status.HypervisorLaunchOk -ne '1') {
        $detail = $(if ($status.RunningInVm -eq '1') { ' This Windows installation is itself virtualized, so the host hypervisor must expose nested virtualization.' } else { '' })
        return [ordered]@{ Success = '0'; Code = 'DISTRO_VIRTUALIZATION_NOT_READY'; Message = "WSL2 virtualization is not available to Windows.$detail"; RebootRequired = '0' }
    }
    if ($status.WslPlatformReady -ne '1') {
        return [ordered]@{ Success = '0'; Code = 'DISTRO_WSL_NOT_READY'; Message = 'WSL 2 must be fully prepared before a Linux distribution can be installed.'; RebootRequired = '0' }
    }

    $wslExe = Get-WslExecutable
    try {
        $setDefault = Invoke-CapturedProcess -FilePath $wslExe -Arguments @('--set-default-version', '2') -TimeoutMs 30000
        if ($setDefault.ExitCode -ne 0) {
            $message = Get-WslFailureMessage -Output ($setDefault.StdOut + "`n" + $setDefault.StdErr) -DefaultMessage 'Could not set WSL 2 as the default distribution version.'
            return [ordered]@{ Success = '0'; Code = 'DISTRO_DEFAULT_FAILED'; Message = $message; RebootRequired = '0' }
        }

        # Microsoft documents --web-download as the Store-independent WSL distro
        # path and --no-launch lets NetWatch separate package installation from the
        # intentionally interactive Linux user-creation window.
        $install = Invoke-CapturedProcess -FilePath $wslExe -Arguments @('--install', '-d', 'Ubuntu', '--no-launch', '--web-download') -TimeoutMs 1200000
        if ($install.ExitCode -ne 0 -and $install.ExitCode -ne 3010) {
            $message = Get-WslFailureMessage -Output ($install.StdOut + "`n" + $install.StdErr) -DefaultMessage "Ubuntu installation failed (exit $($install.ExitCode))."
            return [ordered]@{ Success = '0'; Code = 'DISTRO_INSTALL_FAILED'; Message = $message; RebootRequired = '0' }
        }
        if ($install.ExitCode -eq 3010) {
            return [ordered]@{ Success = '1'; Code = 'DISTRO_REBOOT'; Message = 'Ubuntu was installed, but Windows must restart before it can be initialized.'; RebootRequired = '1' }
        }

        # First launch is intentionally visible and interactive: the user chooses
        # their own Linux username/password. NetWatch never invents or stores them.
        Start-Process -FilePath $wslExe -Wait -WindowStyle Normal -ArgumentList @('-d', 'Ubuntu') | Out-Null
        if (-not (Test-DistroReady -WslExe $wslExe -DistroName 'Ubuntu')) {
            return [ordered]@{ Success = '0'; Code = 'DISTRO_INIT_INCOMPLETE'; Message = 'Ubuntu is installed, but first-run initialization is incomplete. Open Ubuntu, finish creating your Linux user, type exit, then click Refresh checks.'; RebootRequired = '0' }
        }
        return [ordered]@{ Success = '1'; Code = 'DISTRO_INSTALLED'; Message = 'Ubuntu installation and first-run initialization completed. Setup will verify WSL2 now.'; RebootRequired = '0' }
    } catch {
        return [ordered]@{ Success = '0'; Code = 'DISTRO_INSTALL_FAILED'; Message = 'Ubuntu installation or initialization did not complete.'; RebootRequired = '0' }
    }
}

function Initialize-Distro {
    $distros = @(Get-NormalWslDistros | Where-Object { $_.Version -eq 2 })
    if (-not $distros.Count) {
        return [ordered]@{ Success = '0'; Code = 'DISTRO_MISSING'; Message = 'No normal WSL 2 distribution is installed.'; RebootRequired = '0' }
    }

    $wslExe = Get-WslExecutable
    $name = $distros[0].Name
    try {
        Start-Process -FilePath $wslExe -Wait -WindowStyle Normal -ArgumentList @('-d', $name) | Out-Null
        if (-not (Test-DistroReady -WslExe $wslExe -DistroName $name)) {
            return [ordered]@{ Success = '0'; Code = 'DISTRO_INIT_INCOMPLETE'; Message = "$name is installed, but first-run initialization is still incomplete. Finish the Linux user setup and click Refresh checks."; RebootRequired = '0' }
        }
        return [ordered]@{ Success = '1'; Code = 'DISTRO_INITIALIZED'; Message = "$name initialization finished and WSL2 execution was verified."; RebootRequired = '0' }
    } catch {
        return [ordered]@{ Success = '0'; Code = 'DISTRO_INIT_FAILED'; Message = "$name did not finish initialization."; RebootRequired = '0' }
    }
}

function Wait-DockerEngine {
    param([int]$TimeoutSeconds = 180)
    $deadline = [DateTime]::UtcNow.AddSeconds($TimeoutSeconds)
    while ([DateTime]::UtcNow -lt $deadline) {
        $dockerCli = Get-DockerCliExecutable
        if ($dockerCli) {
            $result = Invoke-CapturedProcess -FilePath $dockerCli -Arguments @('info', '--format', '{{.OSType}}') -TimeoutMs 8000
            if ($result.ExitCode -eq 0 -and $result.StdOut.Trim().ToLowerInvariant() -eq 'linux') { return $true }
        }
        Start-Sleep -Seconds 2
    }
    return $false
}

function Test-OfficialDockerDownloadUri {
    param([Parameter(Mandatory = $true)][System.Uri]$Uri)
    return (
        $Uri.IsAbsoluteUri -and
        $Uri.Scheme -eq 'https' -and
        $Uri.Host.Equals('desktop.docker.com', [System.StringComparison]::OrdinalIgnoreCase) -and
        $Uri.Port -eq 443 -and
        [string]::IsNullOrEmpty($Uri.UserInfo)
    )
}

function Download-DockerInstaller {
    $downloadDirectory = Join-Path $env:TEMP 'NetWatchPrerequisites'
    if (-not (Test-Path -LiteralPath $downloadDirectory)) { New-Item -ItemType Directory -Path $downloadDirectory -Force | Out-Null }
    $destination = Join-Path $downloadDirectory 'Docker Desktop Installer.exe'
    Remove-Item -LiteralPath $destination -Force -ErrorAction SilentlyContinue

    Add-Type -AssemblyName System.Net.Http
    $handler = New-Object System.Net.Http.HttpClientHandler
    # Do not let HttpClient follow redirects invisibly. Every hop is validated
    # before the next request so an intermediate host can never receive the
    # Docker download request under NetWatch's bootstrap trust policy.
    $handler.AllowAutoRedirect = $false
    $client = [System.Net.Http.HttpClient]::new($handler)
    $client.Timeout = [TimeSpan]::FromMinutes(20)
    $response = $null
    $maximumRedirects = 5

    try {
        $currentUri = [System.Uri]$DockerDownloadUrl
        if (-not (Test-OfficialDockerDownloadUri -Uri $currentUri)) {
            throw 'Docker download URL is outside the official Docker Desktop host.'
        }

        for ($redirectCount = 0; $redirectCount -le $maximumRedirects; $redirectCount++) {
            if ($response) {
                $response.Dispose()
                $response = $null
            }

            $response = $client.GetAsync($currentUri, [System.Net.Http.HttpCompletionOption]::ResponseHeadersRead).Result
            $statusCode = [int]$response.StatusCode

            if ($statusCode -in @(301, 302, 303, 307, 308)) {
                if ($redirectCount -ge $maximumRedirects) {
                    throw 'Docker download exceeded the NetWatch redirect limit.'
                }
                $location = $response.Headers.Location
                if ($null -eq $location) {
                    throw 'Docker download returned a redirect without a Location header.'
                }
                $nextUri = if ($location.IsAbsoluteUri) { $location } else { [System.Uri]::new($currentUri, $location.OriginalString) }
                if (-not (Test-OfficialDockerDownloadUri -Uri $nextUri)) {
                    throw 'Docker download redirect left the official desktop.docker.com HTTPS host.'
                }
                $currentUri = $nextUri
                continue
            }

            $response.EnsureSuccessStatusCode() | Out-Null
            if (-not (Test-OfficialDockerDownloadUri -Uri $response.RequestMessage.RequestUri)) {
                throw 'Docker download response came from outside the official Docker Desktop host.'
            }
            break
        }

        if (-not $response -or -not $response.IsSuccessStatusCode) {
            throw 'Docker download did not reach a successful response.'
        }

        $contentLength = $response.Content.Headers.ContentLength
        if ($null -ne $contentLength -and [long]$contentLength -gt $MaximumDockerInstallerBytes) {
            throw 'Docker installer is larger than the NetWatch download safety limit.'
        }

        $input = $response.Content.ReadAsStreamAsync().Result
        $output = [System.IO.FileStream]::new($destination, [System.IO.FileMode]::CreateNew, [System.IO.FileAccess]::Write, [System.IO.FileShare]::None)
        try {
            $buffer = New-Object byte[] 1048576
            [long]$written = 0
            while (($read = $input.Read($buffer, 0, $buffer.Length)) -gt 0) {
                $written += $read
                if ($written -gt $MaximumDockerInstallerBytes) { throw 'Docker installer exceeded the NetWatch download safety limit.' }
                $output.Write($buffer, 0, $read)
            }
            $output.Flush()
        } finally {
            $output.Dispose()
            $input.Dispose()
        }
    } catch {
        Remove-Item -LiteralPath $destination -Force -ErrorAction SilentlyContinue
        throw
    } finally {
        if ($response) { $response.Dispose() }
        $client.Dispose()
        $handler.Dispose()
    }

    if (-not (Test-Path -LiteralPath $destination -PathType Leaf)) { throw 'Docker installer download did not produce a file.' }
    return $destination
}

function Test-DockerAuthenticode {
    param([string]$InstallerPath)
    $signature = Get-AuthenticodeSignature -LiteralPath $InstallerPath
    if ($signature.Status -ne 'Valid' -or -not $signature.SignerCertificate) { return $false }
    $subject = [string]$signature.SignerCertificate.Subject
    return ($subject -match '(?i)(?:^|,\s*)(?:O|CN)=Docker Inc(?:,|$)')
}

function Install-Docker {
    $installerPath = ''
    try {
        $installerPath = Download-DockerInstaller
        if (-not (Test-DockerAuthenticode -InstallerPath $installerPath)) {
            return [ordered]@{ Success = '0'; Code = 'DOCKER_SIGNATURE_INVALID'; Message = 'The downloaded Docker Desktop installer did not have a valid Docker Inc. Authenticode signature.'; RebootRequired = '0' }
        }

        # Do not pass --accept-license. Docker Desktop remains separately licensed
        # and presents its own agreement to the user on first launch.
        $install = Start-Process -FilePath $installerPath -Wait -PassThru -ArgumentList @('install', '--user')
        if ($install.ExitCode -ne 0 -and $install.ExitCode -ne 3010) {
            return [ordered]@{ Success = '0'; Code = 'DOCKER_INSTALL_FAILED'; Message = "Docker Desktop installation failed (exit $($install.ExitCode))."; RebootRequired = '0' }
        }

        $dockerDesktop = Get-DockerDesktopExecutable
        $engineReady = $false
        if ($dockerDesktop) {
            Start-Process -FilePath $dockerDesktop | Out-Null
            if ($install.ExitCode -ne 3010) { $engineReady = Wait-DockerEngine -TimeoutSeconds 180 }
        }
        return [ordered]@{
            Success = '1'
            Code = 'DOCKER_INSTALLED'
            Message = $(if ($engineReady) { "Docker Desktop was installed from Docker's signed official installer and its Linux engine is running." } else { "Docker Desktop was installed from Docker's signed official installer. Complete Docker's first-run agreement/settings if prompted, then return to Setup and click Refresh." })
            RebootRequired = $(if ($install.ExitCode -eq 3010) { '1' } else { '0' })
        }
    } catch {
        return [ordered]@{ Success = '0'; Code = 'DOCKER_INSTALL_FAILED'; Message = 'Docker Desktop could not be downloaded, verified, or installed.'; RebootRequired = '0' }
    } finally {
        if ($installerPath) { Remove-Item -LiteralPath $installerPath -Force -ErrorAction SilentlyContinue }
    }
}

function Start-DockerDesktop {
    $dockerDesktop = Get-DockerDesktopExecutable
    if (-not $dockerDesktop) {
        return [ordered]@{ Success = '0'; Code = 'DOCKER_MISSING'; Message = 'Docker Desktop is not installed.'; RebootRequired = '0' }
    }
    try {
        Start-Process -FilePath $dockerDesktop | Out-Null
        $engineReady = Wait-DockerEngine -TimeoutSeconds 180
        return [ordered]@{
            Success = '1'
            Code = 'DOCKER_STARTED'
            Message = $(if ($engineReady) { 'Docker Desktop is running with its Linux engine. Setup will verify WSL integration now.' } else { 'Docker Desktop was opened, but its Linux engine is not ready yet. Complete any Docker first-run agreement/settings, then click Refresh.' })
            RebootRequired = '0'
        }
    } catch {
        return [ordered]@{ Success = '0'; Code = 'DOCKER_START_FAILED'; Message = 'Docker Desktop could not be started.'; RebootRequired = '0' }
    }
}

$actionResult = [ordered]@{ Success = '1'; Code = 'PROBE'; Message = ''; RebootRequired = '0' }
try {
    switch ($Action) {
        'InstallOrUpdateWsl' { $actionResult = Install-OrUpdateWsl }
        'InstallOrUpdateWslElevated' { $actionResult = Enable-WslPlatformElevated }
        'InstallUbuntu' { $actionResult = Install-Ubuntu }
        'InitializeDistro' { $actionResult = Initialize-Distro }
        'InstallDocker' { $actionResult = Install-Docker }
        'StartDocker' { $actionResult = Start-DockerDesktop }
        default { }
    }
    $status = Get-PrerequisiteStatus
} catch {
    $status = [ordered]@{
        ProbeOk = '0'; VirtualizationOk = '0'; HardwareVirtualizationOk = '0'; HypervisorLaunchOk = '0'; RunningInVm = '0'; WslFeatureEnabled = '0'; VirtualMachinePlatformEnabled = '0'; WslPresent = '0'; WslVersion = ''; WslVersionOk = '0'; WslCommandReady = '0'; WslPlatformReady = '0'; WslRuntimeUsable = '0';
        DistroInstalled = '0'; DistroReady = '0'; DistroName = ''; DockerInstalled = '0'; DockerEngineReady = '0'; DockerOsType = '';
        DockerOperatingSystem = ''; DockerDesktopEngine = '0'; DockerWslIntegrationReady = '0'; RebootPending = '0'; BootId = ''; SystemDriveFreeGiB = '-1'; SystemDriveLow = '0'
    }
    if ($Action -eq 'Probe') {
        $actionResult = [ordered]@{ Success = '0'; Code = 'PROBE_FAILED'; Message = 'The prerequisite probe failed. Use the manual setup links or rerun Setup.'; RebootRequired = '0' }
    }
}

Write-StateFile -Status $status -ActionResult $actionResult
if ($actionResult.Success -eq '1') { exit 0 }
exit 1
