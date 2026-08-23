//go:build windows

package main

import (
	"fmt"
	"os"
	"strings"
	"time"
)

func wslFailureMessage(output, fallback string) string {
	lower := strings.ToLower(strings.ReplaceAll(output, "\x00", " "))
	switch {
	case strings.Contains(lower, "hcs_e_hyperv_not_installed") || strings.Contains(lower, "0x80370102") || strings.Contains(lower, "virtualization is not enabled") || strings.Contains(lower, "virtual machine platform"):
		return "WSL2 could not start its virtualization environment. Verify Virtual Machine Platform, hardware virtualization, and nested virtualization if Windows is itself running in a VM."
	case strings.Contains(lower, "0x80070070") || strings.Contains(lower, "not enough disk space") || strings.Contains(lower, "insufficient disk space") || strings.Contains(lower, "disk is full"):
		return "Windows reported insufficient disk space while installing the WSL distribution. Free space on the Windows system drive or use the official WSL installation tools to choose another distro location."
	case strings.Contains(lower, "0x8000ffff"):
		return "Windows reported an unexpected WSL installation failure (0x8000FFFF). Restart Windows, update WSL, and retry; the Microsoft WSL instructions button has the official troubleshooting path."
	}
	return fallback
}

func featureEnabledElevated(name string) bool {
	enabled, known := queryFeatureWithDism(name)
	return known && enabled
}

func enableWslPlatformElevated(sw *stateWriter) actionResult {
	if !isAdministrator() {
		return actionResult{Code: "WSL_ELEVATION_REQUIRED", Message: "Administrator approval is required to enable the Windows WSL features."}
	}
	sw.setPhase("Checking Windows WSL features")
	beforeWsl := featureEnabledElevated("Microsoft-Windows-Subsystem-Linux")
	beforeVMP := featureEnabledElevated("VirtualMachinePlatform")
	featuresChanged := !beforeWsl || !beforeVMP
	restartRequired := false
	dism := nativeSystemExecutable("dism.exe")
	for _, feature := range []string{"Microsoft-Windows-Subsystem-Linux", "VirtualMachinePlatform"} {
		if featureEnabledElevated(feature) {
			continue
		}
		sw.setPhase("Enabling " + feature)
		result := runCaptured(dism, []string{"/Online", "/Enable-Feature", "/FeatureName:" + feature, "/All", "/NoRestart", "/English"}, 10*time.Minute, false)
		if result.TimedOut {
			return actionResult{Code: "WSL_FEATURE_ENABLE_TIMEOUT", Message: "Windows is still applying a required WSL feature. Allow Windows servicing to finish, then click Refresh checks."}
		}
		if result.ExitCode == 3010 {
			restartRequired = true
		}
		if result.ExitCode != 0 && result.ExitCode != 3010 {
			return actionResult{Code: "WSL_FEATURE_ENABLE_FAILED", Message: fmt.Sprintf("Windows could not enable the required WSL feature %s (exit %d).", feature, result.ExitCode)}
		}
	}
	if featuresChanged {
		return actionResult{Success: true, Code: "WSL_FEATURES_ENABLED", Message: "The Windows Subsystem for Linux and Virtual Machine Platform features were enabled. Restart Windows before continuing WSL setup.", RebootRequired: true}
	}

	wsl := getWslCommandPath()
	sw.setPhase("Installing or updating Microsoft WSL")
	versionResult := runCaptured(wsl, []string{"--version"}, 10*time.Second, true)
	versionText, _ := parseWslVersion(versionResult.Stdout + "\n" + versionResult.Stderr)
	var result processResult
	if versionText != "" && versionText != "legacy/inbox" {
		result = runCaptured(wsl, []string{"--update", "--web-download"}, 30*time.Minute, false)
	} else {
		result = runCaptured(wsl, []string{"--install", "--no-distribution", "--web-download"}, 30*time.Minute, false)
	}
	if result.TimedOut {
		return actionResult{Code: "WSL_PACKAGE_TIMEOUT", Message: "The Microsoft WSL package operation is still taking unusually long. Allow any Windows WSL setup process to finish, then click Refresh checks."}
	}
	if result.ExitCode == 3010 {
		restartRequired = true
	}
	if result.ExitCode != 0 && result.ExitCode != 3010 {
		msg := wslFailureMessage(result.Stdout+"\n"+result.Stderr, fmt.Sprintf("The Microsoft WSL package install/update failed (exit %d).", result.ExitCode))
		return actionResult{Code: "WSL_PACKAGE_FAILED", Message: msg}
	}
	if !restartRequired {
		sw.setPhase("Setting WSL 2 as default")
		def := runCaptured(wsl, []string{"--set-default-version", "2"}, 2*time.Minute, true)
		if def.ExitCode != 0 {
			msg := wslFailureMessage(def.Stdout+"\n"+def.Stderr, "WSL was installed, but Windows could not set WSL 2 as the default version.")
			return actionResult{Code: "WSL_DEFAULT_VERSION_FAILED", Message: msg}
		}
	}
	message := "WSL 2 and its required Windows features are ready."
	if restartRequired {
		message = "The WSL package was installed or updated. Restart Windows before installing Ubuntu."
	}
	return actionResult{Success: true, Code: "WSL_PLATFORM_ENABLED", Message: message, RebootRequired: restartRequired}
}

func installUbuntu(sw *stateWriter) actionResult {
	status := getPrerequisiteStatus()
	if status["WslFeatureEnabled"] != "1" || status["VirtualMachinePlatformEnabled"] != "1" {
		return actionResult{Code: "DISTRO_WSL_FEATURES_NOT_READY", Message: "Enable the Windows Subsystem for Linux and Virtual Machine Platform features before installing Ubuntu."}
	}
	if status["RebootPending"] == "1" {
		return actionResult{Code: "DISTRO_REBOOT_REQUIRED", Message: "Windows has pending NetWatch prerequisite changes. Restart Windows before installing Ubuntu.", RebootRequired: true}
	}
	if status["VirtualizationOk"] != "1" || status["HypervisorLaunchOk"] != "1" {
		detail := ""
		if status["RunningInVm"] == "1" {
			detail = " This Windows installation is itself virtualized, so the host hypervisor must expose nested virtualization."
		}
		return actionResult{Code: "DISTRO_VIRTUALIZATION_NOT_READY", Message: "WSL2 virtualization is not available to Windows." + detail}
	}
	if status["WslPlatformReady"] != "1" {
		return actionResult{Code: "DISTRO_WSL_NOT_READY", Message: "WSL 2 must be fully prepared before a Linux distribution can be installed."}
	}
	wsl := getWslExecutable()
	sw.setPhase("Preparing Ubuntu installation")
	def := runCaptured(wsl, []string{"--set-default-version", "2"}, 2*time.Minute, true)
	if def.ExitCode != 0 {
		return actionResult{Code: "DISTRO_DEFAULT_FAILED", Message: wslFailureMessage(def.Stdout+"\n"+def.Stderr, "Could not set WSL 2 as the default distribution version.")}
	}
	sw.setPhase("Installing Ubuntu")
	install := runCaptured(wsl, []string{"--install", "-d", "Ubuntu", "--no-launch", "--web-download"}, 45*time.Minute, false)
	if install.TimedOut {
		return actionResult{Code: "DISTRO_INSTALL_TIMEOUT", Message: "Ubuntu installation is still taking unusually long. Allow the Windows WSL installation to finish, then click Refresh checks."}
	}
	if install.ExitCode == 3010 {
		return actionResult{Success: true, Code: "DISTRO_REBOOT", Message: "Ubuntu was installed, but Windows must restart before it can be initialized.", RebootRequired: true}
	}
	if install.ExitCode != 0 {
		return actionResult{Code: "DISTRO_INSTALL_FAILED", Message: wslFailureMessage(install.Stdout+"\n"+install.Stderr, fmt.Sprintf("Ubuntu installation failed (exit %d).", install.ExitCode))}
	}
	sw.setPhase("Waiting for Ubuntu first-run user setup")
	interactive := runInteractive(wsl, []string{"-d", "Ubuntu"}, 45*time.Minute)
	if interactive.TimedOut {
		return actionResult{Code: "DISTRO_INIT_INCOMPLETE", Message: "Ubuntu is installed and its first-run window is still open. Finish creating your Linux user, type exit, then click Refresh checks."}
	}
	refreshed := getPrerequisiteStatus()
	if refreshed["DistroProvisioned"] != "1" || refreshed["DistroReady"] != "1" {
		return actionResult{Code: "DISTRO_INIT_INCOMPLETE", Message: "Ubuntu is installed, but first-run initialization is incomplete. Open Ubuntu, finish creating your Linux user, type exit, then click Refresh checks."}
	}
	return actionResult{Success: true, Code: "DISTRO_INSTALLED", Message: "Ubuntu installation and first-run initialization completed. Setup verified the normal Linux user and WSL2 execution."}
}

func initializeDistro(sw *stateWriter) actionResult {
	wsl := getWslExecutable()
	distros := normalWslDistros(wsl)
	var target *distroInfo
	for i := range distros {
		if distros[i].Version == 2 {
			target = &distros[i]
			break
		}
	}
	if target == nil {
		return actionResult{Code: "DISTRO_MISSING", Message: "No normal WSL 2 distribution is installed."}
	}
	sw.setPhase("Waiting for " + target.Name + " first-run user setup")
	result := runInteractive(wsl, []string{"-d", target.Name}, 45*time.Minute)
	if result.TimedOut {
		return actionResult{Code: "DISTRO_INIT_INCOMPLETE", Message: target.Name + " is still open. Finish the Linux user setup, type exit, then click Refresh checks."}
	}
	refreshed := getPrerequisiteStatus()
	if refreshed["DistroName"] != target.Name || refreshed["DistroProvisioned"] != "1" || refreshed["DistroReady"] != "1" {
		return actionResult{Code: "DISTRO_INIT_INCOMPLETE", Message: target.Name + " is installed, but first-run initialization is still incomplete. Finish the Linux user setup and click Refresh checks."}
	}
	return actionResult{Success: true, Code: "DISTRO_INITIALIZED", Message: target.Name + " initialization finished; Setup verified its normal Linux user and WSL2 execution."}
}

func installDocker(sw *stateWriter) actionResult {
	installer := ""
	defer func() {
		if installer != "" {
			_ = os.Remove(installer)
		}
	}()
	path, err := downloadDockerInstaller(sw)
	if err != nil {
		return actionResult{Code: "DOCKER_DOWNLOAD_FAILED", Message: "Docker Desktop could not be downloaded from Docker's official endpoint."}
	}
	installer = path
	sw.setPhase("Verifying Docker Desktop signature")
	signer, err := verifyDockerAuthenticode(installer)
	if err != nil {
		return actionResult{Code: "DOCKER_SIGNATURE_INVALID", Message: "The downloaded Docker Desktop installer did not have a trusted Docker Inc. Authenticode signature."}
	}
	if !strings.EqualFold(strings.TrimSuffix(signer, "."), "Docker Inc") {
		return actionResult{Code: "DOCKER_SIGNATURE_INVALID", Message: "The downloaded Docker Desktop signer identity was not Docker Inc."}
	}
	sw.setPhase("Installing Docker Desktop")
	install := shellExecuteAndWait(installer, []string{"install", "--user"}, 45*time.Minute)
	if install.TimedOut {
		return actionResult{Code: "DOCKER_INSTALL_TIMEOUT", Message: "Docker Desktop installation is still taking unusually long. Allow Docker's installer to finish, then click Refresh checks."}
	}
	if install.ExitCode != 0 && install.ExitCode != 3010 {
		return actionResult{Code: "DOCKER_INSTALL_FAILED", Message: fmt.Sprintf("Docker Desktop installation failed (exit %d).", install.ExitCode)}
	}
	dockerDesktop := getDockerDesktopExecutable()
	engineReady := false
	if dockerDesktop != "" {
		sw.setPhase("Starting Docker Desktop")
		_ = startDetached(dockerDesktop, nil)
		if install.ExitCode != 3010 {
			engineReady = waitDockerEngine(3 * time.Minute)
		}
	}
	message := "Docker Desktop was installed from Docker's signed official installer. Complete Docker's first-run agreement/settings if prompted, then return to Setup and click Refresh."
	if engineReady {
		message = "Docker Desktop was installed from Docker's signed official installer and its Linux engine is running."
	}
	return actionResult{Success: true, Code: "DOCKER_INSTALLED", Message: message, RebootRequired: install.ExitCode == 3010}
}

func startDockerDesktop(sw *stateWriter) actionResult {
	dockerDesktop := getDockerDesktopExecutable()
	if dockerDesktop == "" {
		return actionResult{Code: "DOCKER_MISSING", Message: "Docker Desktop is not installed."}
	}
	sw.setPhase("Starting Docker Desktop")
	if err := startDetached(dockerDesktop, nil); err != nil {
		return actionResult{Code: "DOCKER_START_FAILED", Message: "Docker Desktop could not be started."}
	}
	sw.setPhase("Waiting for Docker Linux engine")
	engineReady := waitDockerEngine(3 * time.Minute)
	message := "Docker Desktop was opened, but its Linux engine is not ready yet. Complete any Docker first-run agreement/settings, then click Refresh."
	if engineReady {
		message = "Docker Desktop is running with its Linux engine. Setup will verify WSL integration now."
	}
	return actionResult{Success: true, Code: "DOCKER_STARTED", Message: message}
}
