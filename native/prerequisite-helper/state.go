//go:build windows

package main

import (
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"syscall"
	"time"
	"unsafe"
)

type prereqStatus map[string]string

type actionResult struct {
	Success        bool
	Code           string
	Message        string
	RebootRequired bool
}

type stateWriter struct {
	path      string
	action    string
	mu        sync.Mutex
	phase     string
	heartbeat uint64
	complete  bool
	status    prereqStatus
	result    actionResult
	stop      chan struct{}
	done      chan struct{}
}

var (
	kernel32State   = syscall.NewLazyDLL("kernel32.dll")
	procMoveFileExW = kernel32State.NewProc("MoveFileExW")
)

const (
	moveFileReplaceExisting = 0x00000001
	moveFileWriteThrough    = 0x00000008
)

func sanitizeINI(value string) string {
	value = strings.ReplaceAll(value, "\x00", " ")
	value = strings.ReplaceAll(value, "\r", " ")
	value = strings.ReplaceAll(value, "\n", " ")
	return strings.TrimSpace(value)
}

func newStateWriter(path, action string) (*stateWriter, error) {
	if path == "" || len(path) > 32760 || strings.ContainsAny(path, "\r\n\x00") {
		return nil, fmt.Errorf("invalid state path")
	}
	if !filepath.IsAbs(path) {
		return nil, fmt.Errorf("state path must be absolute")
	}
	parent := filepath.Dir(path)
	if pathHasReparsePoint(parent) {
		return nil, fmt.Errorf("state directory contains a reparse point")
	}
	if err := os.MkdirAll(parent, 0o700); err != nil {
		return nil, fmt.Errorf("create state directory: %w", err)
	}
	sw := &stateWriter{
		path:   path,
		action: action,
		phase:  "Starting",
		status: defaultStatus(),
		result: actionResult{Success: true, Code: "RUNNING"},
		stop:   make(chan struct{}),
		done:   make(chan struct{}),
	}
	sw.heartbeat = uint64(time.Now().UnixMilli())
	if err := sw.writeLocked(); err != nil {
		return nil, err
	}
	go sw.heartbeatLoop()
	return sw, nil
}

func (sw *stateWriter) heartbeatLoop() {
	ticker := time.NewTicker(2 * time.Second)
	defer func() {
		ticker.Stop()
		close(sw.done)
	}()
	for {
		select {
		case <-ticker.C:
			sw.mu.Lock()
			if !sw.complete {
				sw.heartbeat = uint64(time.Now().UnixMilli())
				_ = sw.writeLocked()
			}
			sw.mu.Unlock()
		case <-sw.stop:
			return
		}
	}
}

func (sw *stateWriter) setPhase(phase string) {
	sw.mu.Lock()
	defer sw.mu.Unlock()
	sw.phase = sanitizeINI(phase)
	sw.heartbeat = uint64(time.Now().UnixMilli())
	_ = sw.writeLocked()
}

func (sw *stateWriter) finish(status prereqStatus, result actionResult) error {
	sw.mu.Lock()
	sw.status = status
	sw.result = result
	sw.phase = "Complete"
	sw.complete = true
	sw.heartbeat = uint64(time.Now().UnixMilli())
	err := sw.writeLocked()
	sw.mu.Unlock()
	close(sw.stop)
	<-sw.done
	return err
}

func (sw *stateWriter) writeLocked() error {
	if pathHasReparsePoint(filepath.Dir(sw.path)) || pathHasReparsePoint(sw.path) {
		return fmt.Errorf("state path contains a reparse point")
	}
	run := map[string]string{
		"Protocol":  "2",
		"Action":    sw.action,
		"HelperPid": fmt.Sprintf("%d", os.Getpid()),
		"Complete":  bool01(sw.complete),
		"Phase":     sanitizeINI(sw.phase),
		"Heartbeat": fmt.Sprintf("%d", sw.heartbeat),
	}
	var b strings.Builder
	b.WriteString("[Run]\r\n")
	writeINIMap(&b, run)
	b.WriteString("\r\n[Status]\r\n")
	writeINIMap(&b, sw.status)
	b.WriteString("\r\n[Action]\r\n")
	action := map[string]string{
		"Success":        bool01(sw.result.Success),
		"Code":           sw.result.Code,
		"Message":        sw.result.Message,
		"RebootRequired": bool01(sw.result.RebootRequired),
	}
	writeINIMap(&b, action)

	temp := sw.path + ".tmp"
	if pathHasReparsePoint(temp) {
		return fmt.Errorf("temporary state path contains a reparse point")
	}
	if err := os.WriteFile(temp, []byte(b.String()), 0o600); err != nil {
		return fmt.Errorf("write state: %w", err)
	}
	src, err := syscall.UTF16PtrFromString(temp)
	if err != nil {
		return err
	}
	dst, err := syscall.UTF16PtrFromString(sw.path)
	if err != nil {
		return err
	}
	var lastErr error
	for attempt := 0; attempt < 20; attempt++ {
		r, _, callErr := procMoveFileExW.Call(
			uintptr(unsafe.Pointer(src)),
			uintptr(unsafe.Pointer(dst)),
			moveFileReplaceExisting|moveFileWriteThrough,
		)
		if r != 0 {
			return nil
		}
		lastErr = callErr
		time.Sleep(50 * time.Millisecond)
	}
	_ = os.Remove(temp)
	return fmt.Errorf("replace state file: %v", lastErr)
}

func writeINIMap(b *strings.Builder, values map[string]string) {
	keys := make([]string, 0, len(values))
	for k := range values {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	for _, k := range keys {
		fmt.Fprintf(b, "%s=%s\r\n", sanitizeINI(k), sanitizeINI(values[k]))
	}
}

func bool01(v bool) string {
	if v {
		return "1"
	}
	return "0"
}

func defaultStatus() prereqStatus {
	return prereqStatus{
		"ProbeOk":                       "0",
		"VirtualizationOk":              "0",
		"HardwareVirtualizationOk":      "0",
		"HypervisorLaunchOk":            "0",
		"RunningInVm":                   "0",
		"WslFeatureEnabled":             "0",
		"VirtualMachinePlatformEnabled": "0",
		"WslPresent":                    "0",
		"WslVersion":                    "",
		"WslVersionOk":                  "0",
		"WslCommandReady":               "0",
		"WslPlatformReady":              "0",
		"WslRuntimeUsable":              "0",
		"DistroInstalled":               "0",
		"DistroProvisioned":             "0",
		"DistroReady":                   "0",
		"DistroName":                    "",
		"DockerInstalled":               "0",
		"DockerEngineReady":             "0",
		"DockerOsType":                  "",
		"DockerOperatingSystem":         "",
		"DockerDesktopEngine":           "0",
		"DockerWslIntegrationReady":     "0",
		"RebootPending":                 "0",
		"BootId":                        "",
		"SystemDriveFreeGiB":            "-1",
		"SystemDriveLow":                "0",
	}
}
