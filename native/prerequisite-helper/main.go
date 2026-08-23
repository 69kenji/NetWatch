//go:build windows

package main

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"
)

var allowedActions = map[string]bool{
	"Probe":                      true,
	"InstallOrUpdateWslElevated": true,
	"InstallUbuntu":              true,
	"InitializeDistro":           true,
	"InstallDocker":              true,
	"StartDocker":                true,
}

func parseCLI(args []string) (string, string, error) {
	action := ""
	state := ""
	for i := 0; i < len(args); i++ {
		switch args[i] {
		case "--action":
			if i+1 >= len(args) {
				return "", "", fmt.Errorf("missing --action value")
			}
			i++
			action = args[i]
		case "--state":
			if i+1 >= len(args) {
				return "", "", fmt.Errorf("missing --state value")
			}
			i++
			state = args[i]
		default:
			return "", "", fmt.Errorf("unsupported argument: %s", args[i])
		}
	}
	if !allowedActions[action] {
		return "", "", fmt.Errorf("unsupported action")
	}
	if !validStatePath(state) {
		return "", "", fmt.Errorf("invalid state path")
	}
	return action, filepath.Clean(state), nil
}

func validStatePath(state string) bool {
	if state == "" || len(state) > 32760 || strings.ContainsAny(state, "\r\n\x00") || !filepath.IsAbs(state) {
		return false
	}
	clean := filepath.Clean(state)
	base := strings.ToLower(filepath.Base(clean))
	if base != "netwatch-prerequisites.ini" && base != "netwatch-prerequisites-elevated.ini" {
		return false
	}
	temp, err := filepath.Abs(os.TempDir())
	if err != nil {
		return false
	}
	temp = strings.TrimRight(filepath.Clean(temp), `\/`) + string(os.PathSeparator)
	return strings.HasPrefix(strings.ToLower(clean), strings.ToLower(temp))
}

func executeAction(action string, sw *stateWriter) actionResult {
	switch action {
	case "InstallOrUpdateWslElevated":
		return enableWslPlatformElevated(sw)
	case "InstallUbuntu":
		return installUbuntu(sw)
	case "InitializeDistro":
		return initializeDistro(sw)
	case "InstallDocker":
		return installDocker(sw)
	case "StartDocker":
		return startDockerDesktop(sw)
	default:
		return actionResult{Success: true, Code: "PROBE"}
	}
}

func main() {
	action, statePath, err := parseCLI(os.Args[1:])
	if err != nil {
		os.Exit(2)
	}
	sw, err := newStateWriter(statePath, action)
	if err != nil {
		os.Exit(3)
	}

	result := actionResult{Success: true, Code: "PROBE"}
	func() {
		defer func() {
			if recovered := recover(); recovered != nil {
				result = actionResult{Code: "HELPER_PANIC", Message: "The native prerequisite helper stopped unexpectedly. Click Refresh checks or use the official manual setup links."}
			}
		}()
		result = executeAction(action, sw)
	}()

	sw.setPhase("Verifying prerequisite state")
	status := getPrerequisiteStatus()
	if err := sw.finish(status, result); err != nil {
		os.Exit(4)
	}
	if result.Success {
		os.Exit(0)
	}
	os.Exit(1)
}
