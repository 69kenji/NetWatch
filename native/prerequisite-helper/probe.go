//go:build windows

package main

import (
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"time"
)

const (
	minimumWslMajor          = 2
	minimumWslMinor          = 1
	minimumWslPatch          = 5
	lowSystemDriveWarningGiB = 10.0
)

var versionPattern = regexp.MustCompile(`(?m)(\d+)\.(\d+)\.(\d+)(?:\.(\d+))?`)

type distroInfo struct {
	Name       string
	Version    uint32
	DefaultUID uint32
}

func getWslExecutable() string { return nativeSystemExecutable("wsl.exe") }
func getWslCommandPath() string {
	path := getWslExecutable()
	if path != "" {
		return path
	}
	root := os.Getenv("WINDIR")
	if root == "" {
		root = `C:\Windows`
	}
	return filepath.Join(root, "System32", "wsl.exe")
}

func parseWslVersion(text string) (string, bool) {
	m := versionPattern.FindStringSubmatch(strings.ReplaceAll(text, "\x00", ""))
	if len(m) < 4 {
		return "legacy/inbox", false
	}
	nums := []int{0, 0, 0}
	for i := 0; i < 3; i++ {
		nums[i], _ = strconv.Atoi(m[i+1])
	}
	ok := nums[0] > minimumWslMajor ||
		(nums[0] == minimumWslMajor && nums[1] > minimumWslMinor) ||
		(nums[0] == minimumWslMajor && nums[1] == minimumWslMinor && nums[2] >= minimumWslPatch)
	return m[0], ok
}

func queryFeatureWithDism(name string) (enabled bool, known bool) {
	dism := nativeSystemExecutable("dism.exe")
	result := runCaptured(dism, []string{"/Online", "/Get-FeatureInfo", "/FeatureName:" + name, "/English"}, 20*time.Second, true)
	if result.ExitCode != 0 {
		return false, false
	}
	lower := strings.ToLower(result.Stdout + "\n" + result.Stderr)
	enabledRE := regexp.MustCompile(`(?m)^\s*state\s*:\s*enabled\s*$`)
	disabledRE := regexp.MustCompile(`(?m)^\s*state\s*:\s*disabled\s*$`)
	if enabledRE.MatchString(lower) {
		return true, true
	}
	if disabledRE.MatchString(lower) {
		return false, true
	}
	return false, false
}

func hypervisorLaunchEnabled() bool {
	bcd := nativeSystemExecutable("bcdedit.exe")
	result := runCaptured(bcd, []string{"/enum", "{current}"}, 10*time.Second, true)
	if result.ExitCode != 0 {
		return true
	}
	lower := strings.ToLower(result.Stdout + "\n" + result.Stderr)
	re := regexp.MustCompile(`(?m)^\s*hypervisorlaunchtype\s+off\s*$`)
	return !re.MatchString(lower)
}

func normalWslDistros(wslExe string) []distroInfo {
	const root = `Software\Microsoft\Windows\CurrentVersion\Lxss`
	byName := map[string]distroInfo{}
	for _, sub := range regSubkeys(hkeyCurrentUser, root) {
		path := root + `\` + sub
		name, ok := regString(hkeyCurrentUser, path, "DistributionName")
		if !ok || !validDistroName(name) || strings.EqualFold(name, "docker-desktop") || strings.EqualFold(name, "docker-desktop-data") {
			continue
		}
		version, _ := regDWORDValue(hkeyCurrentUser, path, "Version")
		uid, _ := regDWORDValue(hkeyCurrentUser, path, "DefaultUid")
		byName[strings.ToLower(name)] = distroInfo{Name: name, Version: version, DefaultUID: uid}
	}
	if len(byName) == 0 {
		return nil
	}

	var ordered []string
	if wslExe != "" {
		result := runCaptured(wslExe, []string{"-l", "-q"}, 10*time.Second, true)
		if result.ExitCode == 0 {
			for _, line := range strings.Split(strings.ReplaceAll(result.Stdout, "\x00", ""), "\n") {
				name := strings.TrimSpace(line)
				if info, ok := byName[strings.ToLower(name)]; ok && !containsFold(ordered, info.Name) {
					ordered = append(ordered, info.Name)
				}
			}
		}
	}
	if len(ordered) < len(byName) {
		var rest []string
		for _, info := range byName {
			if !containsFold(ordered, info.Name) {
				rest = append(rest, info.Name)
			}
		}
		sort.Strings(rest)
		ordered = append(ordered, rest...)
	}
	var preferred []string
	for _, n := range ordered {
		if strings.EqualFold(n, "Ubuntu") {
			preferred = append(preferred, n)
			break
		}
	}
	for _, n := range ordered {
		if strings.HasPrefix(strings.ToLower(n), "ubuntu-") && !containsFold(preferred, n) {
			preferred = append(preferred, n)
			break
		}
	}
	for _, n := range ordered {
		if !containsFold(preferred, n) {
			preferred = append(preferred, n)
		}
	}
	out := make([]distroInfo, 0, len(preferred))
	for _, n := range preferred {
		out = append(out, byName[strings.ToLower(n)])
	}
	return out
}

func validDistroName(name string) bool {
	if len(name) < 1 || len(name) > 64 {
		return false
	}
	for _, r := range name {
		if !(r >= 'a' && r <= 'z' || r >= 'A' && r <= 'Z' || r >= '0' && r <= '9' || r == '.' || r == '_' || r == '-') {
			return false
		}
	}
	return true
}
func containsFold(items []string, value string) bool {
	for _, item := range items {
		if strings.EqualFold(item, value) {
			return true
		}
	}
	return false
}

func distroProvisioned(wslExe string, distro distroInfo) bool {
	if wslExe == "" || distro.DefaultUID == 0 || !validDistroName(distro.Name) {
		return false
	}
	uid := strconv.FormatUint(uint64(distro.DefaultUID), 10)
	result := runCaptured(wslExe, []string{"-d", distro.Name, "-u", "root", "--", "getent", "passwd", uid}, 12*time.Second, true)
	if result.ExitCode != 0 || strings.TrimSpace(result.Stdout) == "" {
		return false
	}
	fields := strings.Split(strings.TrimSpace(result.Stdout), ":")
	if len(fields) < 7 || fields[0] == "" {
		return false
	}
	return fields[2] == uid
}

func distroReady(wslExe string, distro distroInfo) (bool, bool) {
	provisioned := distroProvisioned(wslExe, distro)
	if !provisioned {
		return false, false
	}
	result := runCaptured(wslExe, []string{"-d", distro.Name, "--", "id", "-u"}, 10*time.Second, true)
	if result.ExitCode != 0 {
		return true, false
	}
	uid, err := strconv.ParseUint(strings.TrimSpace(result.Stdout), 10, 32)
	return true, err == nil && uint32(uid) == distro.DefaultUID && uid > 0
}

func getDockerDesktopExecutable() string {
	candidates := []string{}
	if v := os.Getenv("LOCALAPPDATA"); v != "" {
		candidates = append(candidates, filepath.Join(v, "Programs", "DockerDesktop", "Docker Desktop.exe"))
	}
	if v := os.Getenv("ProgramFiles"); v != "" {
		candidates = append(candidates, filepath.Join(v, "Docker", "Docker", "Docker Desktop.exe"))
	}
	if v := os.Getenv("ProgramW6432"); v != "" {
		candidates = append(candidates, filepath.Join(v, "Docker", "Docker", "Docker Desktop.exe"))
	}
	for _, candidate := range candidates {
		if info, err := os.Stat(candidate); err == nil && !info.IsDir() {
			return candidate
		}
	}
	return ""
}
func getDockerCLIExecutable() string {
	candidates := []string{}
	if v := os.Getenv("LOCALAPPDATA"); v != "" {
		candidates = append(candidates, filepath.Join(v, "Programs", "DockerDesktop", "resources", "bin", "docker.exe"))
	}
	if v := os.Getenv("ProgramFiles"); v != "" {
		candidates = append(candidates, filepath.Join(v, "Docker", "Docker", "resources", "bin", "docker.exe"))
	}
	if v := os.Getenv("ProgramW6432"); v != "" {
		candidates = append(candidates, filepath.Join(v, "Docker", "Docker", "resources", "bin", "docker.exe"))
	}
	if found, err := exec.LookPath("docker.exe"); err == nil {
		candidates = append(candidates, found)
	}
	for _, candidate := range candidates {
		if info, err := os.Stat(candidate); err == nil && !info.IsDir() {
			return candidate
		}
	}
	return ""
}

func getPrerequisiteStatus() prereqStatus {
	status := defaultStatus()
	wslExe := getWslExecutable()
	status["WslPresent"] = bool01(wslExe != "")
	wslVersion := ""
	wslVersionOK := false
	wslCommandReady := false
	statusResult := processResult{ExitCode: 9009}
	if wslExe != "" {
		versionResult := runCaptured(wslExe, []string{"--version"}, 10*time.Second, true)
		wslVersion, wslVersionOK = parseWslVersion(versionResult.Stdout + "\n" + versionResult.Stderr)
		statusResult = runCaptured(wslExe, []string{"--status"}, 10*time.Second, true)
		wslCommandReady = statusResult.ExitCode == 0
	}
	status["WslVersion"] = wslVersion
	status["WslVersionOk"] = bool01(wslVersionOK)
	status["WslCommandReady"] = bool01(wslCommandReady)

	wslFeature, wslKnown := queryFeatureWithDism("Microsoft-Windows-Subsystem-Linux")
	vmpFeature, vmpKnown := queryFeatureWithDism("VirtualMachinePlatform")
	// Non-elevated DISM queries are not guaranteed to be permitted. A healthy
	// `wsl --status` is the fallback positive signal on Windows 11.
	if !wslKnown {
		wslFeature = wslCommandReady
	}
	if !vmpKnown {
		vmpFeature = wslCommandReady
	}
	status["WslFeatureEnabled"] = bool01(wslFeature)
	status["VirtualMachinePlatformEnabled"] = bool01(vmpFeature)

	hardwareAvailable := processorFeature(pfVirtFirmwareEnabled) && processorFeature(pfSecondLevelAddressTranslation)
	hypervisorLaunch := hypervisorLaunchEnabled()
	vm := runningInVM()
	virtualizationOK := hardwareAvailable || (vmpFeature && wslCommandReady)
	status["HardwareVirtualizationOk"] = bool01(hardwareAvailable)
	status["VirtualizationOk"] = bool01(virtualizationOK)
	status["HypervisorLaunchOk"] = bool01(hypervisorLaunch)
	status["RunningInVm"] = bool01(vm)

	boot := bootID()
	rebootPending := currentUserRebootPending(boot)
	status["BootId"] = boot
	status["RebootPending"] = bool01(rebootPending)
	platformReady := wslFeature && vmpFeature && wslVersionOK && wslCommandReady && virtualizationOK && hypervisorLaunch && !rebootPending
	status["WslPlatformReady"] = bool01(platformReady)

	distros := normalWslDistros(wslExe)
	var chosen *distroInfo
	for i := range distros {
		if distros[i].Version != 2 {
			continue
		}
		if chosen == nil {
			chosen = &distros[i]
		}
		provisioned, ready := distroReady(wslExe, distros[i])
		if provisioned {
			status["DistroProvisioned"] = "1"
		}
		if ready {
			chosen = &distros[i]
			status["DistroProvisioned"] = "1"
			status["DistroReady"] = "1"
			break
		}
	}
	if chosen != nil {
		status["DistroInstalled"] = "1"
		status["DistroName"] = chosen.Name
		if status["DistroReady"] != "1" {
			provisioned, _ := distroReady(wslExe, *chosen)
			status["DistroProvisioned"] = bool01(provisioned)
		}
	}
	status["WslRuntimeUsable"] = status["DistroReady"]

	dockerDesktop := getDockerDesktopExecutable()
	dockerCLI := getDockerCLIExecutable()
	status["DockerInstalled"] = bool01(dockerDesktop != "")
	if dockerCLI != "" {
		result := runCaptured(dockerCLI, []string{"info", "--format", "{{.OSType}}|{{.OperatingSystem}}"}, 10*time.Second, true)
		if result.ExitCode == 0 {
			parts := strings.SplitN(strings.TrimSpace(result.Stdout), "|", 2)
			if len(parts) >= 1 {
				status["DockerOsType"] = strings.ToLower(strings.TrimSpace(parts[0]))
			}
			if len(parts) >= 2 {
				status["DockerOperatingSystem"] = strings.TrimSpace(parts[1])
			}
			if status["DockerOsType"] != "" {
				status["DockerEngineReady"] = "1"
			}
			if strings.Contains(strings.ToLower(status["DockerOperatingSystem"]), "docker desktop") {
				status["DockerDesktopEngine"] = "1"
			}
		}
	}
	if status["DistroReady"] == "1" && wslExe != "" && status["DockerEngineReady"] == "1" && status["DockerOsType"] == "linux" && status["DockerDesktopEngine"] == "1" {
		result := runCaptured(wslExe, []string{"-d", status["DistroName"], "--", "docker", "info"}, 20*time.Second, true)
		if result.ExitCode == 0 {
			status["DockerWslIntegrationReady"] = "1"
		}
	}

	free := systemDriveFreeGiB()
	status["SystemDriveFreeGiB"] = formatGiB(free)
	status["SystemDriveLow"] = bool01(free >= 0 && free < lowSystemDriveWarningGiB)
	status["ProbeOk"] = "1"
	return status
}
