!include "MUI2.nsh"
!include "LogicLib.nsh"
!include "nsDialogs.nsh"
!include "WinMessages.nsh"
!include "x64.nsh"

; Use the standard installer cancellation safeguard. Long-running prerequisite
; operations temporarily disable Cancel so a child installer/helper cannot be
; orphaned; at normal points Cancel asks for explicit confirmation.
!ifndef MUI_ABORTWARNING
  !define MUI_ABORTWARNING
!endif
!ifndef MUI_ABORTWARNING_TEXT
  !define MUI_ABORTWARNING_TEXT "Are you sure you want to cancel NetWatch Setup? Installation will be cancelled."
!endif
!ifndef MUI_ABORTWARNING_CANCEL_DEFAULT
  !define MUI_ABORTWARNING_CANCEL_DEFAULT
!endif

!ifndef PBS_MARQUEE
  !define PBS_MARQUEE 0x08
!endif
!ifndef PBM_SETMARQUEE
  !define /math PBM_SETMARQUEE ${WM_USER} + 10
!endif

!define NETWATCH_DOCKER_DOCS_URL "https://docs.docker.com/desktop/setup/install/windows-install/"
!define NETWATCH_WSL_DOCS_URL "https://learn.microsoft.com/windows/wsl/install"

; This custom include is parsed before electron-builder's multiUser.nsh, so its
; INSTALL_REGISTRY_KEY alias does not exist yet. APP_GUID is passed to makensis
; on the command line and electron-builder's default installer key is
; Software\${APP_GUID}. Keep a local equivalent for early prerequisite logic.
!define NETWATCH_INSTALL_REGISTRY_KEY "Software\${APP_GUID}"

!ifndef BUILD_UNINSTALLER
Var /GLOBAL NetWatchWinEdition
Var /GLOBAL NetWatchWinInstallationType
Var /GLOBAL NetWatchWinBuild
Var /GLOBAL NetWatchWinArchitecture
Var /GLOBAL NetWatchArchitectureSupported
Var /GLOBAL NetWatchWindowsSupported
Var /GLOBAL NetWatchDesktopCheckbox
Var /GLOBAL NetWatchStartMenuCheckbox
Var /GLOBAL NetWatchDesktopState
Var /GLOBAL NetWatchStartMenuState

Var /GLOBAL NetWatchPrereqHelper
Var /GLOBAL NetWatchPrereqState
Var /GLOBAL NetWatchElevatedPrereqState
Var /GLOBAL NetWatchPrereqAction
Var /GLOBAL NetWatchProbeOk
Var /GLOBAL NetWatchVirtualizationOk
Var /GLOBAL NetWatchHardwareVirtualizationOk
Var /GLOBAL NetWatchHypervisorLaunchOk
Var /GLOBAL NetWatchRunningInVm
Var /GLOBAL NetWatchWslFeatureEnabled
Var /GLOBAL NetWatchVirtualMachinePlatformEnabled
Var /GLOBAL NetWatchWslPresent
Var /GLOBAL NetWatchWslVersion
Var /GLOBAL NetWatchWslVersionOk
Var /GLOBAL NetWatchWslCommandReady
Var /GLOBAL NetWatchWslPlatformReady
Var /GLOBAL NetWatchWslRuntimeUsable
Var /GLOBAL NetWatchDistroInstalled
Var /GLOBAL NetWatchDistroProvisioned
Var /GLOBAL NetWatchDistroReady
Var /GLOBAL NetWatchDistroName
Var /GLOBAL NetWatchDockerInstalled
Var /GLOBAL NetWatchDockerEngineReady
Var /GLOBAL NetWatchDockerOsType
Var /GLOBAL NetWatchDockerOperatingSystem
Var /GLOBAL NetWatchDockerDesktopEngine
Var /GLOBAL NetWatchDockerWslIntegrationReady
Var /GLOBAL NetWatchRebootPending
Var /GLOBAL NetWatchBootId
Var /GLOBAL NetWatchSystemDriveFreeGiB
Var /GLOBAL NetWatchSystemDriveLow
Var /GLOBAL NetWatchAllPrereqsReady
Var /GLOBAL NetWatchActionSuccess
Var /GLOBAL NetWatchActionMessage
Var /GLOBAL NetWatchActionRebootRequired

Var /GLOBAL NetWatchPreflightDialog
Var /GLOBAL NetWatchStatusLabel
Var /GLOBAL NetWatchWslButton
Var /GLOBAL NetWatchDistroButton
Var /GLOBAL NetWatchDockerButton
Var /GLOBAL NetWatchRefreshButton
Var /GLOBAL NetWatchWslDocsButton
Var /GLOBAL NetWatchDockerDocsButton
Var /GLOBAL NetWatchProgressBar
Var /GLOBAL NetWatchBackButton
Var /GLOBAL NetWatchNextButton
Var /GLOBAL NetWatchCancelButton
Var /GLOBAL NetWatchBusy
Var /GLOBAL NetWatchAsyncElevated
Var /GLOBAL NetWatchAsyncTicks
Var /GLOBAL NetWatchAsyncMessage
Var /GLOBAL NetWatchRunComplete
Var /GLOBAL NetWatchRunHeartbeat
Var /GLOBAL NetWatchRunLastHeartbeat
Var /GLOBAL NetWatchRunStaleTicks
Var /GLOBAL NetWatchRunPhase

Function NetWatchDetectWindowsAndShortcutState
  SetShellVarContext current

  StrCpy $NetWatchWindowsSupported "0"
  StrCpy $NetWatchArchitectureSupported "0"
  StrCpy $NetWatchDesktopState ${BST_CHECKED}
  StrCpy $NetWatchStartMenuState ${BST_CHECKED}

  ; electron-builder calls check64BitAndSetRegView before customInit,
  ; so these reads use the native Windows registry view.
  ReadRegStr $NetWatchWinEdition HKLM "SOFTWARE\Microsoft\Windows NT\CurrentVersion" "EditionID"
  ReadRegStr $NetWatchWinInstallationType HKLM "SOFTWARE\Microsoft\Windows NT\CurrentVersion" "InstallationType"
  ReadRegStr $NetWatchWinBuild HKLM "SOFTWARE\Microsoft\Windows NT\CurrentVersion" "CurrentBuildNumber"
  ; Read the native machine architecture from the system environment registry.
  ; This remains authoritative even when the installer is a 32-bit NSIS process.
  ReadRegStr $NetWatchWinArchitecture HKLM "SYSTEM\CurrentControlSet\Control\Session Manager\Environment" "PROCESSOR_ARCHITECTURE"
  ${If} $NetWatchWinArchitecture == "AMD64"
    StrCpy $NetWatchArchitectureSupported "1"
  ${EndIf}
  ${If} $NetWatchWinBuild == ""
    ReadRegStr $NetWatchWinBuild HKLM "SOFTWARE\Microsoft\Windows NT\CurrentVersion" "CurrentBuild"
  ${EndIf}

  ; NetWatch uses only the WSL2/Linux-container path, which is available on
  ; Windows 11 Home as well as Pro/Enterprise/Education. Edition is therefore
  ; informational: the authoritative gates are a supported Windows 11 client
  ; build plus the capability checks on the prerequisite page. InstallationType
  ; keeps Windows Server out of the desktop bootstrap path.
  ${If} $NetWatchWinBuild >= 22631
  ${AndIf} $NetWatchWinInstallationType == "Client"
  ${AndIf} $NetWatchArchitectureSupported == "1"
    StrCpy $NetWatchWindowsSupported "1"
  ${EndIf}

  ; Preserve shortcut choices on reinstall/update. Capture the user's current
  ; shortcut presence before electron-builder uninstalls the old version.
  ReadRegStr $0 HKCU "${NETWATCH_INSTALL_REGISTRY_KEY}" "InstallLocation"
  ${If} $0 != ""
    StrCpy $NetWatchDesktopState ${BST_UNCHECKED}
    StrCpy $NetWatchStartMenuState ${BST_UNCHECKED}
    ${If} ${FileExists} "$DESKTOP\${SHORTCUT_NAME}.lnk"
      StrCpy $NetWatchDesktopState ${BST_CHECKED}
    ${EndIf}
    ${If} ${FileExists} "$SMPROGRAMS\${SHORTCUT_NAME}.lnk"
      StrCpy $NetWatchStartMenuState ${BST_CHECKED}
    ${EndIf}
  ${EndIf}
FunctionEnd

Function NetWatchExtractPrerequisiteHelper
  InitPluginsDir
  SetOutPath "$PLUGINSDIR"
  ; 1.0.4 uses a project-owned fixed-purpose native helper. No PowerShell,
  ; cmd.exe, WMI scripting, or arbitrary shell command is used by the
  ; prerequisite bootstrap path.
  File /oname=netwatch-prerequisites.exe "${BUILD_RESOURCES_DIR}\netwatch-prerequisites.exe"
  StrCpy $NetWatchPrereqHelper "$PLUGINSDIR\netwatch-prerequisites.exe"
  StrCpy $NetWatchPrereqState "$PLUGINSDIR\netwatch-prerequisites.ini"
  StrCpy $NetWatchElevatedPrereqState "$PLUGINSDIR\netwatch-prerequisites-elevated.ini"
FunctionEnd

Function NetWatchReadPrerequisiteState
  StrCpy $NetWatchProbeOk "0"
  StrCpy $NetWatchVirtualizationOk "0"
  StrCpy $NetWatchHardwareVirtualizationOk "0"
  StrCpy $NetWatchHypervisorLaunchOk "0"
  StrCpy $NetWatchRunningInVm "0"
  StrCpy $NetWatchWslFeatureEnabled "0"
  StrCpy $NetWatchVirtualMachinePlatformEnabled "0"
  StrCpy $NetWatchWslPresent "0"
  StrCpy $NetWatchWslVersion ""
  StrCpy $NetWatchWslVersionOk "0"
  StrCpy $NetWatchWslCommandReady "0"
  StrCpy $NetWatchWslPlatformReady "0"
  StrCpy $NetWatchWslRuntimeUsable "0"
  StrCpy $NetWatchDistroInstalled "0"
  StrCpy $NetWatchDistroProvisioned "0"
  StrCpy $NetWatchDistroReady "0"
  StrCpy $NetWatchDistroName ""
  StrCpy $NetWatchDockerInstalled "0"
  StrCpy $NetWatchDockerEngineReady "0"
  StrCpy $NetWatchDockerOsType ""
  StrCpy $NetWatchDockerOperatingSystem ""
  StrCpy $NetWatchDockerDesktopEngine "0"
  StrCpy $NetWatchDockerWslIntegrationReady "0"
  StrCpy $NetWatchRebootPending "0"
  StrCpy $NetWatchBootId ""
  StrCpy $NetWatchSystemDriveFreeGiB ""
  StrCpy $NetWatchSystemDriveLow "0"
  StrCpy $NetWatchActionSuccess "0"
  StrCpy $NetWatchActionMessage ""
  StrCpy $NetWatchActionRebootRequired "0"

  IfFileExists "$NetWatchPrereqState" 0 state_done
  ReadINIStr $NetWatchProbeOk "$NetWatchPrereqState" "Status" "ProbeOk"
  ReadINIStr $NetWatchVirtualizationOk "$NetWatchPrereqState" "Status" "VirtualizationOk"
  ReadINIStr $NetWatchHardwareVirtualizationOk "$NetWatchPrereqState" "Status" "HardwareVirtualizationOk"
  ReadINIStr $NetWatchHypervisorLaunchOk "$NetWatchPrereqState" "Status" "HypervisorLaunchOk"
  ReadINIStr $NetWatchRunningInVm "$NetWatchPrereqState" "Status" "RunningInVm"
  ReadINIStr $NetWatchWslFeatureEnabled "$NetWatchPrereqState" "Status" "WslFeatureEnabled"
  ReadINIStr $NetWatchVirtualMachinePlatformEnabled "$NetWatchPrereqState" "Status" "VirtualMachinePlatformEnabled"
  ReadINIStr $NetWatchWslPresent "$NetWatchPrereqState" "Status" "WslPresent"
  ReadINIStr $NetWatchWslVersion "$NetWatchPrereqState" "Status" "WslVersion"
  ReadINIStr $NetWatchWslVersionOk "$NetWatchPrereqState" "Status" "WslVersionOk"
  ReadINIStr $NetWatchWslCommandReady "$NetWatchPrereqState" "Status" "WslCommandReady"
  ReadINIStr $NetWatchWslPlatformReady "$NetWatchPrereqState" "Status" "WslPlatformReady"
  ReadINIStr $NetWatchWslRuntimeUsable "$NetWatchPrereqState" "Status" "WslRuntimeUsable"
  ReadINIStr $NetWatchDistroInstalled "$NetWatchPrereqState" "Status" "DistroInstalled"
  ReadINIStr $NetWatchDistroProvisioned "$NetWatchPrereqState" "Status" "DistroProvisioned"
  ReadINIStr $NetWatchDistroReady "$NetWatchPrereqState" "Status" "DistroReady"
  ReadINIStr $NetWatchDistroName "$NetWatchPrereqState" "Status" "DistroName"
  ReadINIStr $NetWatchDockerInstalled "$NetWatchPrereqState" "Status" "DockerInstalled"
  ReadINIStr $NetWatchDockerEngineReady "$NetWatchPrereqState" "Status" "DockerEngineReady"
  ReadINIStr $NetWatchDockerOsType "$NetWatchPrereqState" "Status" "DockerOsType"
  ReadINIStr $NetWatchDockerOperatingSystem "$NetWatchPrereqState" "Status" "DockerOperatingSystem"
  ReadINIStr $NetWatchDockerDesktopEngine "$NetWatchPrereqState" "Status" "DockerDesktopEngine"
  ReadINIStr $NetWatchDockerWslIntegrationReady "$NetWatchPrereqState" "Status" "DockerWslIntegrationReady"
  ReadINIStr $NetWatchRebootPending "$NetWatchPrereqState" "Status" "RebootPending"
  ReadINIStr $NetWatchBootId "$NetWatchPrereqState" "Status" "BootId"
  ReadINIStr $NetWatchSystemDriveFreeGiB "$NetWatchPrereqState" "Status" "SystemDriveFreeGiB"
  ReadINIStr $NetWatchSystemDriveLow "$NetWatchPrereqState" "Status" "SystemDriveLow"
  ReadINIStr $NetWatchActionSuccess "$NetWatchPrereqState" "Action" "Success"
  ReadINIStr $NetWatchActionMessage "$NetWatchPrereqState" "Action" "Message"
  ReadINIStr $NetWatchActionRebootRequired "$NetWatchPrereqState" "Action" "RebootRequired"

state_done:
  StrCpy $NetWatchAllPrereqsReady "0"
  ${If} $NetWatchWindowsSupported == "1"
  ${AndIf} $NetWatchProbeOk == "1"
  ${AndIf} $NetWatchWslPlatformReady == "1"
  ${AndIf} $NetWatchWslRuntimeUsable == "1"
  ${AndIf} $NetWatchDistroReady == "1"
  ${AndIf} $NetWatchDockerInstalled == "1"
  ${AndIf} $NetWatchDockerEngineReady == "1"
  ${AndIf} $NetWatchDockerOsType == "linux"
  ${AndIf} $NetWatchDockerDesktopEngine == "1"
  ${AndIf} $NetWatchDockerWslIntegrationReady == "1"
    StrCpy $NetWatchAllPrereqsReady "1"
  ${EndIf}

  ${If} $NetWatchAllPrereqsReady == "1"
    ; A previously scheduled resume is no longer necessary.
    DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\RunOnce" "NetWatchSetupResume"
  ${EndIf}
FunctionEnd

Function NetWatchInvokePrerequisiteHelper
  ; Synchronous helper use is kept only for customInit, before the prerequisite
  ; page is visible. Interactive page actions use the timer-driven async path
  ; below so Windows never labels NetWatch Setup "Not Responding".
  Delete "$NetWatchPrereqState"
  nsExec::ExecToStack '"$NetWatchPrereqHelper" --action $NetWatchPrereqAction --state "$NetWatchPrereqState"'
  Pop $0
  Pop $1
  Call NetWatchReadPrerequisiteState
FunctionEnd

Function NetWatchBeginBusy
  StrCpy $NetWatchBusy "1"
  StrCpy $NetWatchAsyncTicks "0"
  StrCpy $NetWatchRunComplete "0"
  StrCpy $NetWatchRunHeartbeat ""
  StrCpy $NetWatchRunLastHeartbeat ""
  StrCpy $NetWatchRunStaleTicks "0"
  StrCpy $NetWatchRunPhase "Starting"

  ${If} $NetWatchStatusLabel != ""
    ${NSD_SetText} $NetWatchStatusLabel "$NetWatchAsyncMessage"
  ${EndIf}
  ${If} $NetWatchProgressBar != ""
    ShowWindow $NetWatchProgressBar 1
    SendMessage $NetWatchProgressBar ${PBM_SETMARQUEE} 1 35
  ${EndIf}

  EnableWindow $NetWatchWslButton 0
  EnableWindow $NetWatchDistroButton 0
  EnableWindow $NetWatchDockerButton 0
  EnableWindow $NetWatchRefreshButton 0
  EnableWindow $NetWatchWslDocsButton 0
  EnableWindow $NetWatchDockerDocsButton 0
  EnableWindow $NetWatchNextButton 0
  EnableWindow $NetWatchBackButton 0
  ; Do not allow Setup to be closed while a WSL/Docker child operation is still
  ; running. At all normal points MUI_ABORTWARNING provides the requested
  ; confirmation dialog before cancellation.
  EnableWindow $NetWatchCancelButton 0
FunctionEnd

Function NetWatchEndBusy
  StrCpy $NetWatchBusy "0"
  ${If} $NetWatchProgressBar != ""
    SendMessage $NetWatchProgressBar ${PBM_SETMARQUEE} 0 0
    ShowWindow $NetWatchProgressBar 0
  ${EndIf}
  EnableWindow $NetWatchRefreshButton 1
  EnableWindow $NetWatchWslDocsButton 1
  EnableWindow $NetWatchDockerDocsButton 1
  EnableWindow $NetWatchBackButton 1
  EnableWindow $NetWatchCancelButton 1
FunctionEnd

Function NetWatchAsyncFailedToStart
  ${NSD_KillTimer} NetWatchPollAsyncPrerequisite
  Call NetWatchEndBusy
  StrCpy $NetWatchActionSuccess "0"
  StrCpy $NetWatchActionMessage "Windows could not start the requested prerequisite helper. NetWatch Setup itself does not need to run as Administrator."
  StrCpy $NetWatchActionRebootRequired "0"
  Call NetWatchHandleActionResult
FunctionEnd

Function NetWatchStartAsyncPrerequisite
  Delete "$NetWatchPrereqState"
  StrCpy $NetWatchAsyncElevated "0"
  Call NetWatchBeginBusy
  ClearErrors
  ExecShell "open" "$NetWatchPrereqHelper" '--action $NetWatchPrereqAction --state "$NetWatchPrereqState"' SW_HIDE
  IfErrors async_start_failed
  ${NSD_CreateTimer} NetWatchPollAsyncPrerequisite 500
  Return
async_start_failed:
  Call NetWatchAsyncFailedToStart
FunctionEnd

Function NetWatchStartAsyncElevatedWslHelper
  Delete "$NetWatchElevatedPrereqState"
  StrCpy $NetWatchAsyncElevated "1"
  Call NetWatchBeginBusy
  ClearErrors

  ; Request elevation directly from Windows ShellExecute. Setup itself remains
  ; current-user/asInvoker; only this fixed-purpose native WSL helper crosses UAC.
  ExecShell "runas" "$NetWatchPrereqHelper" '--action InstallOrUpdateWslElevated --state "$NetWatchElevatedPrereqState"' SW_HIDE
  IfErrors elevation_cancelled
  ${NSD_CreateTimer} NetWatchPollAsyncPrerequisite 500
  Return

elevation_cancelled:
  Call NetWatchEndBusy
  StrCpy $NetWatchActionSuccess "0"
  StrCpy $NetWatchActionMessage "Administrator approval was cancelled or Windows could not start the WSL helper. NetWatch Setup itself does not need to run as Administrator."
  StrCpy $NetWatchActionRebootRequired "0"
  Call NetWatchHandleActionResult
FunctionEnd

Function NetWatchPollAsyncPrerequisite
  IntOp $NetWatchAsyncTicks $NetWatchAsyncTicks + 1

  ${If} $NetWatchAsyncElevated == "1"
    StrCpy $0 "$NetWatchElevatedPrereqState"
  ${Else}
    StrCpy $0 "$NetWatchPrereqState"
  ${EndIf}

  IfFileExists "$0" 0 async_no_state_yet

  ReadINIStr $NetWatchRunComplete "$0" "Run" "Complete"
  ReadINIStr $NetWatchRunHeartbeat "$0" "Run" "Heartbeat"
  ReadINIStr $NetWatchRunPhase "$0" "Run" "Phase"

  ${If} $NetWatchRunComplete == "1"
    Goto async_state_ready
  ${EndIf}

  ; The native helper rewrites Heartbeat every two seconds from an independent
  ; goroutine. If endpoint security or another process terminates the helper, the
  ; state file remains but this value stops advancing. Detect that explicitly
  ; instead of waiting an hour or treating a half-finished prerequisite as ready.
  ${If} $NetWatchRunHeartbeat != ""
    ${If} $NetWatchRunHeartbeat != $NetWatchRunLastHeartbeat
      StrCpy $NetWatchRunLastHeartbeat "$NetWatchRunHeartbeat"
      StrCpy $NetWatchRunStaleTicks "0"
    ${Else}
      IntOp $NetWatchRunStaleTicks $NetWatchRunStaleTicks + 1
    ${EndIf}
  ${EndIf}

  ${If} $NetWatchRunPhase != ""
  ${AndIf} $NetWatchStatusLabel != ""
    ${NSD_SetText} $NetWatchStatusLabel "$NetWatchAsyncMessage$\r$\nPhase: $NetWatchRunPhase"
  ${EndIf}

  ; 60 polls x 500 ms = 30 seconds without a heartbeat. Long WSL/Docker work is
  ; safe because the heartbeat is independent of the child process being waited on.
  ${If} $NetWatchRunStaleTicks >= 60
    Goto async_helper_interrupted
  ${EndIf}

async_no_state_yet:
  ; Allow up to one minute for process startup/UAC before declaring that the
  ; helper never started. Once a state file exists the heartbeat rule above is
  ; the authoritative liveness check.
  ${If} $NetWatchAsyncTicks == 120
    IfFileExists "$0" +2 0
    Goto async_helper_interrupted
  ${EndIf}

  ; One hour remains only an absolute UI ceiling for an unusually slow Docker
  ; install. The helper has operation-specific limits and a live heartbeat.
  ${If} $NetWatchAsyncTicks >= 7200
    ${NSD_KillTimer} NetWatchPollAsyncPrerequisite
    Call NetWatchEndBusy
    StrCpy $NetWatchActionSuccess "0"
    StrCpy $NetWatchActionMessage "The prerequisite operation exceeded one hour. Do not force-close any Windows, WSL, Ubuntu, or Docker setup still running. Allow it to finish, then click Refresh checks."
    StrCpy $NetWatchActionRebootRequired "0"
    Call NetWatchHandleActionResult
  ${EndIf}
  Return

async_helper_interrupted:
  ${NSD_KillTimer} NetWatchPollAsyncPrerequisite
  Call NetWatchEndBusy
  StrCpy $NetWatchActionSuccess "0"
  StrCpy $NetWatchActionMessage "The NetWatch prerequisite helper stopped reporting progress. Endpoint security or another process may have interrupted setup. Do not reset or unregister WSL automatically; allow any Microsoft/Ubuntu/Docker setup still running to finish, then click Refresh checks or use the official manual setup links."
  StrCpy $NetWatchActionRebootRequired "0"
  Call NetWatchHandleActionResult
  Return

async_state_ready:
  ${NSD_KillTimer} NetWatchPollAsyncPrerequisite
  ${If} $NetWatchAsyncElevated == "1"
    Delete "$NetWatchPrereqState"
    Rename "$NetWatchElevatedPrereqState" "$NetWatchPrereqState"
  ${EndIf}
  Call NetWatchReadPrerequisiteState
  Call NetWatchEndBusy
  ; A completed helper always contains a fresh post-operation probe snapshot.
  Call NetWatchHandleActionResult
FunctionEnd

Function NetWatchRefreshPrerequisites
  StrCpy $NetWatchPrereqAction "Probe"
  Call NetWatchInvokePrerequisiteHelper
FunctionEnd

Function NetWatchOpenDockerDocs
  ExecShell "open" "${NETWATCH_DOCKER_DOCS_URL}"
FunctionEnd

Function NetWatchOpenWslDocs
  ExecShell "open" "${NETWATCH_WSL_DOCS_URL}"
FunctionEnd

Function NetWatchUpdatePreflightControls
  ${If} $NetWatchStatusLabel == ""
    Return
  ${EndIf}
  ${If} $NetWatchBusy == "1"
    Return
  ${EndIf}

  ${If} $NetWatchWindowsSupported == "1"
    StrCpy $0 "Windows: supported ($NetWatchWinEdition, build $NetWatchWinBuild)"
  ${Else}
    StrCpy $0 "Windows: UNSUPPORTED ($NetWatchWinEdition, build $NetWatchWinBuild)"
  ${EndIf}

  ${If} $NetWatchArchitectureSupported == "1"
    StrCpy $0 "$0$\r$\nArchitecture: x64 ($NetWatchWinArchitecture)"
  ${Else}
    StrCpy $0 "$0$\r$\nArchitecture: UNSUPPORTED ($NetWatchWinArchitecture; NetWatch 1.0 requires x64/AMD64)"
  ${EndIf}

  ${If} $NetWatchProbeOk != "1"
    StrCpy $0 "$0$\r$\nPrerequisite probe: FAILED — use the official manual setup links or rerun Setup."
  ${Else}
    ${If} $NetWatchHardwareVirtualizationOk == "1"
      ${If} $NetWatchRunningInVm == "1"
        StrCpy $0 "$0$\r$\nVirtualization: available (nested virtualization extensions detected)"
      ${Else}
        StrCpy $0 "$0$\r$\nVirtualization: available"
      ${EndIf}
    ${ElseIf} $NetWatchVirtualizationOk == "1"
      ${If} $NetWatchRunningInVm == "1"
        ; Hyper-V commonly masks Win32_Processor virtualization flags after its
        ; hypervisor starts. Do not falsely block Ubuntu: the first WSL2 distro
        ; launch is the authoritative nested-virtualization test.
        StrCpy $0 "$0$\r$\nVirtualization: hypervisor active; nested extensions are masked — WSL2 execution will be verified with Ubuntu"
      ${Else}
        StrCpy $0 "$0$\r$\nVirtualization: hypervisor active; hardware flags are masked"
      ${EndIf}
    ${ElseIf} $NetWatchRunningInVm == "1"
      StrCpy $0 "$0$\r$\nVirtualization: NOT AVAILABLE — expose nested VT-x/AMD-V from the host hypervisor"
    ${Else}
      StrCpy $0 "$0$\r$\nVirtualization: NOT AVAILABLE — enable VT-x/AMD-V in firmware"
    ${EndIf}

    ${If} $NetWatchHypervisorLaunchOk != "1"
      StrCpy $0 "$0$\r$\nHypervisor launch: DISABLED (hypervisorlaunchtype Off)"
    ${EndIf}

    ${If} $NetWatchWslFeatureEnabled == "1"
    ${AndIf} $NetWatchVirtualMachinePlatformEnabled == "1"
      StrCpy $0 "$0$\r$\nWSL Windows features: enabled"
    ${Else}
      StrCpy $0 "$0$\r$\nWSL Windows features: NOT READY (WSL + Virtual Machine Platform required)"
    ${EndIf}

    ${If} $NetWatchWslVersionOk == "1"
    ${AndIf} $NetWatchWslCommandReady == "1"
      StrCpy $0 "$0$\r$\nWSL package: ready (version $NetWatchWslVersion)"
    ${ElseIf} $NetWatchWslPresent == "1"
      StrCpy $0 "$0$\r$\nWSL package: install/update required (detected $NetWatchWslVersion; need 2.1.5+)"
    ${Else}
      StrCpy $0 "$0$\r$\nWSL package: not ready"
    ${EndIf}

    ${If} $NetWatchDistroReady == "1"
      StrCpy $0 "$0$\r$\nWSL2 runtime: verified ($NetWatchDistroName)"
    ${ElseIf} $NetWatchDistroInstalled == "1"
    ${AndIf} $NetWatchDistroProvisioned != "1"
      StrCpy $0 "$0$\r$\nWSL2 runtime: distro installed but Linux user initialization is incomplete ($NetWatchDistroName)"
    ${ElseIf} $NetWatchDistroInstalled == "1"
      StrCpy $0 "$0$\r$\nWSL2 runtime: distro initialized, but execution verification failed ($NetWatchDistroName)"
    ${ElseIf} $NetWatchWslPlatformReady == "1"
      StrCpy $0 "$0$\r$\nWSL2 runtime: platform prepared; install Ubuntu to verify execution"
    ${Else}
      StrCpy $0 "$0$\r$\nWSL2 runtime: not ready"
    ${EndIf}

    ${If} $NetWatchDockerInstalled != "1"
      StrCpy $0 "$0$\r$\nDocker Desktop: not installed"
    ${ElseIf} $NetWatchDockerEngineReady != "1"
      StrCpy $0 "$0$\r$\nDocker Desktop: installed, engine not ready"
    ${ElseIf} $NetWatchDockerOsType != "linux"
      StrCpy $0 "$0$\r$\nDocker Desktop: wrong engine — NetWatch requires Linux containers"
    ${ElseIf} $NetWatchDockerDesktopEngine != "1"
      StrCpy $0 "$0$\r$\nDocker Desktop: docker CLI is connected to a different engine/context"
    ${ElseIf} $NetWatchDockerWslIntegrationReady != "1"
      StrCpy $0 "$0$\r$\nDocker Desktop: running, but WSL integration is not ready for $NetWatchDistroName. Enable it in Docker Desktop > Settings > Resources > WSL Integration, Apply & restart, then Refresh."
    ${Else}
      StrCpy $0 "$0$\r$\nDocker Desktop: ready (Linux engine + $NetWatchDistroName integration)"
    ${EndIf}

    ${If} $NetWatchSystemDriveLow == "1"
      StrCpy $0 "$0$\r$\nStorage warning: only $NetWatchSystemDriveFreeGiB GiB free on the Windows system drive"
    ${EndIf}

    ${If} $NetWatchRebootPending == "1"
      StrCpy $0 "$0$\r$\nWindows: restart required before WSL2 setup can continue"
    ${EndIf}
  ${EndIf}

  ${NSD_SetText} $NetWatchStatusLabel "$0"

  ; Unsupported Windows/architecture is still a hard gate, but edition is not.
  ; Windows 11 Home can use NetWatch's WSL2/Linux-container path. NetWatch 1.0
  ; ships an x64 Windows/Electron/mpv stack, so ARM64 is deliberately deferred.
  ${If} $NetWatchWindowsSupported != "1"
    ${NSD_SetText} $NetWatchWslButton "Unsupported Windows"
    EnableWindow $NetWatchWslButton 0
    ${NSD_SetText} $NetWatchDistroButton "Unsupported Windows"
    EnableWindow $NetWatchDistroButton 0
    ${NSD_SetText} $NetWatchDockerButton "Unsupported Windows"
    EnableWindow $NetWatchDockerButton 0
  ${Else}
    ; WSL action button. A pending reboot is handled explicitly rather than
    ; running another privileged operation against a half-applied Windows state.
    ${If} $NetWatchRebootPending == "1"
      ${NSD_SetText} $NetWatchWslButton "Restart Windows"
      EnableWindow $NetWatchWslButton 1
    ${ElseIf} $NetWatchWslFeatureEnabled == "1"
    ${AndIf} $NetWatchVirtualMachinePlatformEnabled == "1"
    ${AndIf} $NetWatchWslVersionOk == "1"
    ${AndIf} $NetWatchWslCommandReady == "1"
      ${NSD_SetText} $NetWatchWslButton "WSL ready"
      EnableWindow $NetWatchWslButton 0
    ${Else}
      ${NSD_SetText} $NetWatchWslButton "Install / update WSL"
      EnableWindow $NetWatchWslButton 1
    ${EndIf}

    ; Ubuntu is only allowed once the complete WSL2 platform has passed the
    ; pre-distro checks. Actual WSL2 execution is then proven by launching Ubuntu.
    ${If} $NetWatchRebootPending == "1"
      ${NSD_SetText} $NetWatchDistroButton "Restart Windows first"
      EnableWindow $NetWatchDistroButton 0
    ${ElseIf} $NetWatchWslPlatformReady != "1"
      ${NSD_SetText} $NetWatchDistroButton "WSL 2 not ready"
      EnableWindow $NetWatchDistroButton 0
    ${ElseIf} $NetWatchDistroReady == "1"
      ${NSD_SetText} $NetWatchDistroButton "WSL distro ready"
      EnableWindow $NetWatchDistroButton 0
    ${ElseIf} $NetWatchDistroInstalled == "1"
      ${NSD_SetText} $NetWatchDistroButton "Finish WSL distro setup"
      EnableWindow $NetWatchDistroButton 1
    ${Else}
      ${NSD_SetText} $NetWatchDistroButton "Install Ubuntu"
      EnableWindow $NetWatchDistroButton 1
    ${EndIf}

    ; Docker bootstrap is deliberately sequenced after a verified normal WSL2
    ; distro. This keeps Docker from becoming another source of WSL feature changes.
    ${If} $NetWatchWslPlatformReady != "1"
      ${NSD_SetText} $NetWatchDockerButton "WSL 2 required first"
      EnableWindow $NetWatchDockerButton 0
    ${ElseIf} $NetWatchDistroReady != "1"
      ${NSD_SetText} $NetWatchDockerButton "Ubuntu required first"
      EnableWindow $NetWatchDockerButton 0
    ${ElseIf} $NetWatchDockerInstalled != "1"
      ${NSD_SetText} $NetWatchDockerButton "Install Docker Desktop"
      EnableWindow $NetWatchDockerButton 1
    ${ElseIf} $NetWatchDockerEngineReady == "1"
    ${AndIf} $NetWatchDockerOsType == "linux"
    ${AndIf} $NetWatchDockerDesktopEngine == "1"
    ${AndIf} $NetWatchDockerWslIntegrationReady == "1"
      ${NSD_SetText} $NetWatchDockerButton "Docker ready"
      EnableWindow $NetWatchDockerButton 0
    ${ElseIf} $NetWatchDockerEngineReady == "1"
    ${AndIf} $NetWatchDockerOsType == "linux"
    ${AndIf} $NetWatchDockerDesktopEngine == "1"
      ${NSD_SetText} $NetWatchDockerButton "Configure WSL integration"
      EnableWindow $NetWatchDockerButton 1
    ${Else}
      ${NSD_SetText} $NetWatchDockerButton "Open Docker Desktop"
      EnableWindow $NetWatchDockerButton 1
    ${EndIf}
  ${EndIf}

  GetDlgItem $1 $HWNDPARENT 1
  ${If} $NetWatchAllPrereqsReady == "1"
    EnableWindow $1 1
  ${Else}
    EnableWindow $1 0
  ${EndIf}
FunctionEnd

Function NetWatchOfferRebootResume
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\RunOnce" "NetWatchSetupResume" '$\"$EXEPATH$\"'
  MessageBox MB_YESNO|MB_ICONQUESTION "A Windows restart is required. NetWatch Setup has registered itself to resume automatically after your next sign-in.$\r$\n$\r$\nRestart Windows now?" IDNO reboot_later
  Exec '"$SYSDIR\shutdown.exe" /r /t 0'
  Quit
reboot_later:
  MessageBox MB_OK|MB_ICONINFORMATION "Restart Windows when convenient. NetWatch Setup will reopen automatically after your next sign-in and re-check every prerequisite."
FunctionEnd

Function NetWatchHandleActionResult
  ${If} $NetWatchActionMessage != ""
    ${If} $NetWatchActionSuccess == "1"
      MessageBox MB_OK|MB_ICONINFORMATION "$NetWatchActionMessage"
    ${Else}
      MessageBox MB_OK|MB_ICONEXCLAMATION "$NetWatchActionMessage"
    ${EndIf}
  ${EndIf}

  ${If} $NetWatchActionRebootRequired == "1"
    ; Record exactly which Windows boot NetWatch changed. The prerequisite probe
    ; only gates on this NetWatch-owned marker, never on unrelated Windows Update
    ; or PendingFileRenameOperations state. A real reboot changes BootId and the
    ; probe clears the marker automatically.
    ${If} $NetWatchBootId != ""
      WriteRegStr HKCU "Software\NetWatch\Installer" "RebootRequiredBootId" "$NetWatchBootId"
    ${EndIf}
    StrCpy $NetWatchRebootPending "1"
    Call NetWatchOfferRebootResume
  ${EndIf}

  Call NetWatchUpdatePreflightControls
FunctionEnd

Function NetWatchInstallOrUpdateWsl
  ${If} $NetWatchRebootPending == "1"
    Call NetWatchOfferRebootResume
    Return
  ${EndIf}
  MessageBox MB_YESNO|MB_ICONQUESTION "NetWatch can enable the two Microsoft WSL2 Windows features and install/update Microsoft's WSL package.$\r$\n$\r$\nOnly this fixed-purpose native helper requests UAC administrator approval; NetWatch Setup itself remains a current-user process. A restart may be required. Ubuntu is a separate later step.$\r$\n$\r$\nContinue?" IDNO wsl_action_done
  StrCpy $NetWatchAsyncMessage "Working: applying Windows WSL2 prerequisites.$\r$\nThis can take several minutes. Keep NetWatch Setup open; Windows may show its own WSL download progress window."
  Call NetWatchStartAsyncElevatedWslHelper
wsl_action_done:
FunctionEnd

Function NetWatchInstallOrInitializeDistro
  ${If} $NetWatchSystemDriveLow == "1"
    MessageBox MB_YESNO|MB_ICONEXCLAMATION "Only $NetWatchSystemDriveFreeGiB GiB is free on the Windows system drive. WSL distribution installation and Windows servicing still use system-drive space even when other storage is available.$\r$\n$\r$\nContinue anyway?" IDNO distro_action_done
  ${EndIf}
  ${If} $NetWatchDistroInstalled == "1"
    MessageBox MB_YESNO|MB_ICONQUESTION "The WSL 2 distribution $NetWatchDistroName is installed but not yet usable. NetWatch can open it so you can complete its normal Linux first-run initialization.$\r$\n$\r$\nNetWatch does not create or store your Linux username/password. Finish the Linux prompt, then type exit to return to Setup.$\r$\n$\r$\nContinue?" IDNO distro_action_done
    StrCpy $NetWatchPrereqAction "InitializeDistro"
  ${Else}
    MessageBox MB_YESNO|MB_ICONQUESTION "NetWatch requires a normal WSL 2 Linux distribution in addition to Docker Desktop.$\r$\n$\r$\nSetup can install Microsoft's Ubuntu distribution using wsl.exe. Ubuntu will then open once so you can choose your own Linux username/password. Finish the prompt and type exit to return to Setup.$\r$\n$\r$\nContinue?" IDNO distro_action_done
    StrCpy $NetWatchPrereqAction "InstallUbuntu"
  ${EndIf}
  ${If} $NetWatchPrereqAction == "InstallUbuntu"
    StrCpy $NetWatchAsyncMessage "Working: installing Ubuntu for WSL2.$\r$\nWindows may show WSL download progress. Ubuntu will then open so you can create your Linux user. NetWatch never stores that username or password."
  ${Else}
    StrCpy $NetWatchAsyncMessage "Working: waiting for $NetWatchDistroName first-run initialization.$\r$\nComplete the visible Linux username/password prompt, then type exit. Setup will verify the distro automatically."
  ${EndIf}
  Call NetWatchStartAsyncPrerequisite
distro_action_done:
FunctionEnd

Function NetWatchInstallOrStartDocker
  ${If} $NetWatchSystemDriveLow == "1"
    MessageBox MB_YESNO|MB_ICONEXCLAMATION "Only $NetWatchSystemDriveFreeGiB GiB is free on the Windows system drive. Docker Desktop uses system-drive space for installation and its default WSL data store.$\r$\n$\r$\nContinue anyway?" IDNO docker_action_done
  ${EndIf}
  ${If} $NetWatchDockerInstalled != "1"
    MessageBox MB_YESNO|MB_ICONQUESTION "NetWatch can download Docker Desktop for Windows directly from Docker's official desktop.docker.com endpoint.$\r$\n$\r$\nBefore execution, Setup verifies a valid Docker Inc. Authenticode signature. Docker Desktop is licensed separately by Docker; NetWatch does NOT accept Docker's license on your behalf.$\r$\n$\r$\nContinue with Docker's recommended per-user installation?" IDNO docker_action_done
    StrCpy $NetWatchPrereqAction "InstallDocker"
    StrCpy $NetWatchAsyncMessage "Working: downloading, verifying, and installing Docker Desktop.$\r$\nDocker's signed installer and first-run agreement may appear. Setup remains responsive while Docker completes."
  ${Else}
    ${If} $NetWatchDockerEngineReady == "1"
    ${AndIf} $NetWatchDockerOsType == "linux"
    ${AndIf} $NetWatchDockerDesktopEngine == "1"
    ${AndIf} $NetWatchDockerWslIntegrationReady != "1"
      MessageBox MB_OK|MB_ICONINFORMATION "Docker Desktop is running, but integration is not enabled for $NetWatchDistroName.$\r$\n$\r$\nIn Docker Desktop open Settings > Resources > WSL Integration, enable $NetWatchDistroName, then choose Apply & restart. Return to NetWatch Setup and click Refresh checks."
    ${EndIf}
    StrCpy $NetWatchPrereqAction "StartDocker"
    StrCpy $NetWatchAsyncMessage "Working: opening Docker Desktop and checking its Linux engine.$\r$\nComplete Docker's first-run agreement/settings if shown. Setup will refresh the prerequisite state automatically when the helper finishes."
  ${EndIf}
  Call NetWatchStartAsyncPrerequisite
docker_action_done:
FunctionEnd

Function NetWatchRefreshPreflightPage
  StrCpy $NetWatchPrereqAction "Probe"
  StrCpy $NetWatchAsyncMessage "Refreshing prerequisite checks..."
  Call NetWatchStartAsyncPrerequisite
FunctionEnd

Function NetWatchPreflightPageCreate
  ; Do not call electron-builder's isUpdated helper from this custom include.
  ; installer.nsh is parsed before electron-builder adds the StdUtils plugin
  ; directory. Manual reinstall/upgrade should show this page anyway.
  nsDialogs::Create 1018
  Pop $NetWatchPreflightDialog
  ${If} $NetWatchPreflightDialog == error
    Abort
  ${EndIf}

  !insertmacro MUI_HEADER_TEXT "System prerequisites" "NetWatch can verify and, with your approval, bootstrap the supported WSL/Docker runtime."

  ${NSD_CreateLabel} 0 0 100% 88u "Checking prerequisites..."
  Pop $NetWatchStatusLabel

  ; Indeterminate/marquee progress: prerequisite helper does not expose a
  ; trustworthy percentage. A moving segment shows activity without implying
  ; fake completion progress. The control keeps the normal Windows visual style.
  ${NSD_CreateProgressBar} 0 94u 100% 8u ""
  Pop $NetWatchProgressBar
  ${NSD_AddStyle} $NetWatchProgressBar ${PBS_MARQUEE}
  ShowWindow $NetWatchProgressBar 0

  ${NSD_CreateButton} 0 106u 49% 16u "Install / update WSL"
  Pop $NetWatchWslButton
  ${NSD_OnClick} $NetWatchWslButton NetWatchInstallOrUpdateWsl

  ${NSD_CreateButton} 51% 106u 49% 16u "Install Ubuntu"
  Pop $NetWatchDistroButton
  ${NSD_OnClick} $NetWatchDistroButton NetWatchInstallOrInitializeDistro

  ${NSD_CreateButton} 0 126u 49% 16u "Install Docker Desktop"
  Pop $NetWatchDockerButton
  ${NSD_OnClick} $NetWatchDockerButton NetWatchInstallOrStartDocker

  ${NSD_CreateButton} 51% 126u 49% 16u "Refresh checks"
  Pop $NetWatchRefreshButton
  ${NSD_OnClick} $NetWatchRefreshButton NetWatchRefreshPreflightPage

  ${NSD_CreateButton} 0 148u 49% 14u "Microsoft WSL instructions"
  Pop $NetWatchWslDocsButton
  ${NSD_OnClick} $NetWatchWslDocsButton NetWatchOpenWslDocs

  ${NSD_CreateButton} 51% 148u 49% 14u "Docker installation instructions"
  Pop $NetWatchDockerDocsButton
  ${NSD_OnClick} $NetWatchDockerDocsButton NetWatchOpenDockerDocs

  GetDlgItem $NetWatchNextButton $HWNDPARENT 1
  GetDlgItem $NetWatchCancelButton $HWNDPARENT 2
  GetDlgItem $NetWatchBackButton $HWNDPARENT 3

  Call NetWatchUpdatePreflightControls
  nsDialogs::Show
FunctionEnd

Function NetWatchPreflightPageLeave
  ${If} $NetWatchWindowsSupported != "1"
    MessageBox MB_OK|MB_ICONSTOP "NetWatch 1.0 requires an x64 (AMD64) Windows 11 desktop/client installation at build 22631 (23H2) or newer. Home, Pro, Enterprise, and Education are accepted when the WSL2/Docker capability checks pass. ARM64 is not supported by this 1.0 build."
    Abort
  ${EndIf}
  ${If} $NetWatchAllPrereqsReady != "1"
    MessageBox MB_OK|MB_ICONSTOP "NetWatch prerequisites are not ready yet. Resolve the checks shown on this page and click Refresh. Setup will not bypass the WSL/Docker runtime requirements."
    Abort
  ${EndIf}
FunctionEnd

; This must be a macro rather than an early Function. electron-builder includes
; this file before installer.nsi declares $appExe and before its WinShell
; plugin-backed shortcut helpers are compiled. The macro body is expanded by
; customInstall later, after electron-builder has initialized that context.
!macro NetWatchCreateOrRemoveShortcuts
  SetShellVarContext current

  ${If} $NetWatchDesktopState == ${BST_CHECKED}
    CreateShortCut "$DESKTOP\${SHORTCUT_NAME}.lnk" "$appExe" "" "$appExe" 0 "" "" "${APP_DESCRIPTION}"
    ClearErrors
    WinShell::SetLnkAUMI "$DESKTOP\${SHORTCUT_NAME}.lnk" "${APP_ID}"
  ${Else}
    WinShell::UninstShortcut "$DESKTOP\${SHORTCUT_NAME}.lnk"
    Delete "$DESKTOP\${SHORTCUT_NAME}.lnk"
  ${EndIf}

  ${If} $NetWatchStartMenuState == ${BST_CHECKED}
    CreateShortCut "$SMPROGRAMS\${SHORTCUT_NAME}.lnk" "$appExe" "" "$appExe" 0 "" "" "${APP_DESCRIPTION}"
    ClearErrors
    WinShell::SetLnkAUMI "$SMPROGRAMS\${SHORTCUT_NAME}.lnk" "${APP_ID}"
  ${Else}
    WinShell::UninstShortcut "$SMPROGRAMS\${SHORTCUT_NAME}.lnk"
    Delete "$SMPROGRAMS\${SHORTCUT_NAME}.lnk"
  ${EndIf}

  System::Call 'shell32::SHChangeNotify(i, i, i, i) v (0x08000000, 0, 0, 0)'
!macroend

Function NetWatchOptionsPageCreate
  nsDialogs::Create 1018
  Pop $0
  ${If} $0 == error
    Abort
  ${EndIf}

  !insertmacro MUI_HEADER_TEXT "Install options" "Choose which shortcuts NetWatch Setup should create."

  ${NSD_CreateLabel} 0 0 100% 24u "These choices affect shortcuts only. NetWatch remains a current-user installation."
  Pop $0

  ${NSD_CreateCheckbox} 0 36u 100% 12u "Create a desktop shortcut"
  Pop $NetWatchDesktopCheckbox
  ${NSD_SetState} $NetWatchDesktopCheckbox $NetWatchDesktopState

  ${NSD_CreateCheckbox} 0 58u 100% 12u "Create a Start menu shortcut"
  Pop $NetWatchStartMenuCheckbox
  ${NSD_SetState} $NetWatchStartMenuCheckbox $NetWatchStartMenuState

  ${NSD_CreateLabel} 0 86u 100% 32u "Fresh installs default both shortcuts on. Reinstalling NetWatch preserves whether each shortcut currently exists."
  Pop $0

  nsDialogs::Show
FunctionEnd

Function NetWatchOptionsPageLeave
  ${NSD_GetState} $NetWatchDesktopCheckbox $NetWatchDesktopState
  ${NSD_GetState} $NetWatchStartMenuCheckbox $NetWatchStartMenuState
FunctionEnd

!macro customInstallMode
  ; Keep the established NetWatch installer model: current-user only. The
  ; installer itself remains unelevated; only the explicit Microsoft WSL action
  ; can trigger a UAC prompt through wsl.exe.
  StrCpy $isForceCurrentInstall "1"
!macroend

!macro customInit
  StrCpy $NetWatchBusy "0"
  StrCpy $NetWatchAsyncElevated "0"
  Call NetWatchDetectWindowsAndShortcutState
  Call NetWatchExtractPrerequisiteHelper
  Call NetWatchRefreshPrerequisites
!macroend

!macro customWelcomePage
  !define MUI_WELCOMEPAGE_TITLE "Welcome to NetWatch Setup"
  !define MUI_WELCOMEPAGE_TEXT "Setup installs NetWatch for the current Windows user. You can keep the default application folder or choose another writable location on the next installer pages.$\r$\n$\r$\nThe chosen application folder contains NetWatch itself and its bundled resources. WSL, Ubuntu, Docker Desktop/data, and temporary prerequisite downloads use their own Windows/Microsoft/Docker-managed locations.$\r$\n$\r$\nBefore application files are installed, Setup verifies Windows, x64 architecture, hardware virtualization, WSL 2, a normal WSL Linux distribution, Docker Desktop, the Linux Docker engine, and Docker integration with that distribution.$\r$\n$\r$\nMissing prerequisites can be installed only after you explicitly approve each action."
  !insertmacro MUI_PAGE_WELCOME
!macroend

!macro customPageAfterChangeDir
  Page custom NetWatchPreflightPageCreate NetWatchPreflightPageLeave
  Page custom NetWatchOptionsPageCreate NetWatchOptionsPageLeave
!macroend

!macro customInstall
  ; electron-builder has already installed the application files and set
  ; $appExe when this macro runs. Apply the choices captured before install.
  !insertmacro NetWatchCreateOrRemoveShortcuts
  DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\RunOnce" "NetWatchSetupResume"
!macroend
!endif

!ifdef BUILD_UNINSTALLER
!macro customUnInstall
  ; Shortcuts are created by our custom installer options rather than
  ; electron-builder's unconditional shortcut macros, so remove either one
  ; if it exists. Never remove WSL, Docker Desktop, distributions, or NetWatch's
  ; WSL-backed private state during normal application uninstall.
  SetShellVarContext current
  WinShell::UninstShortcut "$DESKTOP\${SHORTCUT_NAME}.lnk"
  Delete "$DESKTOP\${SHORTCUT_NAME}.lnk"
  WinShell::UninstShortcut "$SMPROGRAMS\${SHORTCUT_NAME}.lnk"
  Delete "$SMPROGRAMS\${SHORTCUT_NAME}.lnk"
!macroend
!endif
