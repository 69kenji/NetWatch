//go:build windows

// NetWatch Windows video-surface helper.
//
// This helper has one deliberately narrow responsibility: find mpv's --wid
// child HWND under the Electron video host, show it, and keep it fitted to the
// host client area. It never launches another process, invokes a scripting
// host, or performs network access.
package main

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"strconv"
	"syscall"
	"time"
	"unsafe"
)

const (
	swShow           = 5
	swpNoActivate    = 0x0010
	swpShowWindow    = 0x0040
	surfacePollDelay = 16 * time.Millisecond
	findPollDelay    = 25 * time.Millisecond
)

var (
	user32                       = syscall.NewLazyDLL("user32.dll")
	procEnumChildWindows         = user32.NewProc("EnumChildWindows")
	procGetWindowThreadProcessID = user32.NewProc("GetWindowThreadProcessId")
	procGetClientRect            = user32.NewProc("GetClientRect")
	procShowWindow               = user32.NewProc("ShowWindow")
	procSetWindowPos             = user32.NewProc("SetWindowPos")
	procIsWindow                 = user32.NewProc("IsWindow")
)

type rect struct {
	Left   int32
	Top    int32
	Right  int32
	Bottom int32
}

type watchResult struct {
	ChildHWND  uint64 `json:"ChildHwnd"`
	ParentHWND uint64 `json:"ParentHwnd"`
	ProcessID  uint32 `json:"ProcessId"`
}

func usageError(message string) error {
	return fmt.Errorf("%s\nusage: netwatch-surface-helper.exe watch --parent <hwnd> --pid <pid> --timeout-ms <ms>", message)
}

func parseOption(args []string, name string) (string, bool) {
	for i := 0; i+1 < len(args); i++ {
		if args[i] == name {
			return args[i+1], true
		}
	}
	return "", false
}

func parseUint64Option(args []string, name string) (uint64, error) {
	value, ok := parseOption(args, name)
	if !ok {
		return 0, usageError("missing " + name)
	}
	parsed, err := strconv.ParseUint(value, 10, 64)
	if err != nil || parsed == 0 {
		return 0, fmt.Errorf("invalid %s: %q", name, value)
	}
	return parsed, nil
}

func parseUint32Option(args []string, name string) (uint32, error) {
	value, err := parseUint64Option(args, name)
	if err != nil {
		return 0, err
	}
	if value > uint64(^uint32(0)) {
		return 0, fmt.Errorf("%s is out of range", name)
	}
	return uint32(value), nil
}

func isWindow(hwnd uintptr) bool {
	result, _, _ := procIsWindow.Call(hwnd)
	return result != 0
}

func findChildWindow(parent uintptr, targetPID uint32) uintptr {
	var found uintptr
	callback := syscall.NewCallback(func(hwnd uintptr, lparam uintptr) uintptr {
		var pid uint32
		procGetWindowThreadProcessID.Call(hwnd, uintptr(unsafe.Pointer(&pid)))
		if pid == targetPID {
			found = hwnd
			return 0
		}
		return 1
	})
	procEnumChildWindows.Call(parent, callback, 0)
	return found
}

func fitSurface(parent uintptr, child uintptr, lastWidth *int32, lastHeight *int32, force bool) (bool, error) {
	if !isWindow(parent) || !isWindow(child) {
		return false, nil
	}

	var client rect
	ok, _, callErr := procGetClientRect.Call(parent, uintptr(unsafe.Pointer(&client)))
	if ok == 0 {
		return false, fmt.Errorf("GetClientRect failed: %v", callErr)
	}

	width := client.Right - client.Left
	height := client.Bottom - client.Top
	if width < 1 {
		width = 1
	}
	if height < 1 {
		height = 1
	}

	if !force && width == *lastWidth && height == *lastHeight {
		return true, nil
	}

	procShowWindow.Call(child, swShow)
	ok, _, callErr = procSetWindowPos.Call(
		child,
		0, // HWND_TOP
		0,
		0,
		uintptr(width),
		uintptr(height),
		swpNoActivate|swpShowWindow,
	)
	if ok == 0 {
		return false, fmt.Errorf("SetWindowPos failed: %v", callErr)
	}

	*lastWidth = width
	*lastHeight = height
	return true, nil
}

func watchSurface(args []string) error {
	parentValue, err := parseUint64Option(args, "--parent")
	if err != nil {
		return err
	}
	targetPID, err := parseUint32Option(args, "--pid")
	if err != nil {
		return err
	}

	timeoutValue, ok := parseOption(args, "--timeout-ms")
	if !ok {
		return usageError("missing --timeout-ms")
	}
	timeoutMs, err := strconv.Atoi(timeoutValue)
	if err != nil || timeoutMs < 100 || timeoutMs > 60000 {
		return fmt.Errorf("invalid --timeout-ms: %q", timeoutValue)
	}

	parent := uintptr(parentValue)
	deadline := time.Now().Add(time.Duration(timeoutMs) * time.Millisecond)
	var child uintptr
	for time.Now().Before(deadline) {
		child = findChildWindow(parent, targetPID)
		if child != 0 {
			break
		}
		time.Sleep(findPollDelay)
	}
	if child == 0 {
		return fmt.Errorf("timed out waiting for mpv child HWND under parent %d for PID %d", parentValue, targetPID)
	}

	var lastWidth int32 = -1
	var lastHeight int32 = -1
	alive, err := fitSurface(parent, child, &lastWidth, &lastHeight, true)
	if err != nil {
		return err
	}
	if !alive {
		return errors.New("mpv video surface disappeared before initial fit")
	}

	if err := json.NewEncoder(os.Stdout).Encode(watchResult{
		ChildHWND:  uint64(child),
		ParentHWND: parentValue,
		ProcessID:  targetPID,
	}); err != nil {
		return fmt.Errorf("write watcher result: %w", err)
	}

	for isWindow(parent) && isWindow(child) {
		alive, err := fitSurface(parent, child, &lastWidth, &lastHeight, false)
		if err != nil {
			return err
		}
		if !alive {
			break
		}
		time.Sleep(surfacePollDelay)
	}
	return nil
}

func run() error {
	if len(os.Args) < 2 {
		return usageError("missing command")
	}
	if os.Args[1] != "watch" {
		return usageError("unsupported command: " + os.Args[1])
	}
	return watchSurface(os.Args[2:])
}

func main() {
	if err := run(); err != nil {
		_ = json.NewEncoder(os.Stderr).Encode(map[string]string{"error": err.Error()})
		os.Exit(1)
	}
}
