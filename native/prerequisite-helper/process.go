//go:build windows

package main

import (
	"bytes"
	"errors"
	"fmt"
	"os/exec"
	"strings"
	"sync"
	"syscall"
	"time"
	"unsafe"
)

const (
	createNewConsole = 0x00000010
)

type processResult struct {
	ExitCode int
	Stdout   string
	Stderr   string
	TimedOut bool
}

type cappedBuffer struct {
	mu  sync.Mutex
	b   bytes.Buffer
	max int
}

func (c *cappedBuffer) Write(p []byte) (int, error) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.max <= 0 {
		return len(p), nil
	}
	remaining := c.max - c.b.Len()
	if remaining > 0 {
		if len(p) > remaining {
			_, _ = c.b.Write(p[:remaining])
		} else {
			_, _ = c.b.Write(p)
		}
	}
	return len(p), nil
}
func (c *cappedBuffer) String() string {
	c.mu.Lock()
	defer c.mu.Unlock()
	return strings.TrimSpace(strings.ReplaceAll(c.b.String(), "\x00", ""))
}

func validateArgs(args []string) error {
	for _, arg := range args {
		if len(arg) > 32760 || strings.ContainsAny(arg, "\r\n\x00") {
			return errors.New("unsafe process argument")
		}
	}
	return nil
}

func runCaptured(path string, args []string, timeout time.Duration, killOnTimeout bool) processResult {
	if path == "" {
		return processResult{ExitCode: 9009, Stderr: "Executable not found."}
	}
	if err := validateArgs(args); err != nil {
		return processResult{ExitCode: 87, Stderr: err.Error()}
	}

	cmd := exec.Command(path, args...)
	stdout := &cappedBuffer{max: 1024 * 1024}
	stderr := &cappedBuffer{max: 1024 * 1024}
	cmd.Stdout = stdout
	cmd.Stderr = stderr
	if err := cmd.Start(); err != nil {
		return processResult{ExitCode: 9009, Stderr: err.Error()}
	}

	done := make(chan error, 1)
	go func() { done <- cmd.Wait() }()
	if timeout <= 0 {
		err := <-done
		return processExitResult(cmd, err, stdout, stderr)
	}
	select {
	case err := <-done:
		return processExitResult(cmd, err, stdout, stderr)
	case <-time.After(timeout):
		if killOnTimeout && cmd.Process != nil {
			_ = cmd.Process.Kill()
			<-done
		}
		return processResult{ExitCode: 1460, Stderr: "Process timed out.", TimedOut: true}
	}
}

func processExitResult(cmd *exec.Cmd, err error, stdout, stderr *cappedBuffer) processResult {
	code := 0
	if cmd.ProcessState != nil {
		code = cmd.ProcessState.ExitCode()
	}
	if err != nil && code == 0 {
		code = 1
	}
	return processResult{ExitCode: code, Stdout: stdout.String(), Stderr: stderr.String()}
}

func runInteractive(path string, args []string, timeout time.Duration) processResult {
	if path == "" {
		return processResult{ExitCode: 9009, Stderr: "Executable not found."}
	}
	if err := validateArgs(args); err != nil {
		return processResult{ExitCode: 87, Stderr: err.Error()}
	}

	// Do not use os/exec for the interactive Ubuntu first-run session. With
	// nil Cmd stdin/stdout/stderr, os/exec intentionally connects the child to
	// the null device. Combining that with CREATE_NEW_CONSOLE produces a visible
	// but blank WSL console that cannot accept the Linux username/password.
	//
	// CreateProcessW with CREATE_NEW_CONSOLE and no STARTF_USESTDHANDLES lets
	// Windows create the new console's normal input/output handles for wsl.exe.
	app, err := syscall.UTF16PtrFromString(path)
	if err != nil {
		return processResult{ExitCode: 87, Stderr: err.Error()}
	}
	parts := make([]string, 0, len(args)+1)
	parts = append(parts, syscall.EscapeArg(path))
	for _, arg := range args {
		parts = append(parts, syscall.EscapeArg(arg))
	}
	commandLine, err := syscall.UTF16FromString(strings.Join(parts, " "))
	if err != nil {
		return processResult{ExitCode: 87, Stderr: err.Error()}
	}
	startup := syscall.StartupInfo{Cb: uint32(unsafe.Sizeof(syscall.StartupInfo{}))}
	var processInfo syscall.ProcessInformation
	if err := syscall.CreateProcess(
		app,
		&commandLine[0],
		nil,
		nil,
		false,
		createNewConsole,
		nil,
		nil,
		&startup,
		&processInfo,
	); err != nil {
		return processResult{ExitCode: 9009, Stderr: err.Error()}
	}
	defer syscall.CloseHandle(processInfo.Thread)
	defer syscall.CloseHandle(processInfo.Process)

	waitMs := uint32(syscall.INFINITE)
	if timeout > 0 {
		ms := timeout / time.Millisecond
		if ms < 1 {
			ms = 1
		}
		if ms < time.Duration(syscall.INFINITE) {
			waitMs = uint32(ms)
		}
	}
	waitResult, waitErr := syscall.WaitForSingleObject(processInfo.Process, waitMs)
	if waitResult == syscall.WAIT_TIMEOUT {
		// Deliberately do not terminate an interactive WSL first-run session.
		// The user may still be completing account creation in its own window.
		return processResult{ExitCode: 1460, Stderr: "Interactive process is still running.", TimedOut: true}
	}
	if waitErr != nil || waitResult != syscall.WAIT_OBJECT_0 {
		return processResult{ExitCode: 1, Stderr: fmt.Sprintf("WaitForSingleObject failed: %v", waitErr)}
	}
	var code uint32
	if err := syscall.GetExitCodeProcess(processInfo.Process, &code); err != nil {
		return processResult{ExitCode: 1, Stderr: fmt.Sprintf("GetExitCodeProcess failed: %v", err)}
	}
	return processResult{ExitCode: int(code)}
}

func startDetached(path string, args []string) error {
	if err := validateArgs(args); err != nil {
		return err
	}
	cmd := exec.Command(path, args...)
	if err := cmd.Start(); err != nil {
		return err
	}
	if cmd.Process != nil {
		return cmd.Process.Release()
	}
	return fmt.Errorf("process did not start")
}

const (
	seeMaskNoCloseProcess = 0x00000040
	swShowNormal          = 1
	waitObject0           = 0x00000000
	waitTimeout           = 0x00000102
)

type shellExecuteInfo struct {
	CbSize        uint32
	FMask         uint32
	Hwnd          uintptr
	Verb          *uint16
	File          *uint16
	Parameters    *uint16
	Directory     *uint16
	NShow         int32
	_             uint32
	HInstApp      uintptr
	IDList        uintptr
	Class         *uint16
	HKeyClass     uintptr
	HotKey        uint32
	_2            uint32
	IconOrMonitor uintptr
	Process       uintptr
}

var (
	shell32Process          = syscall.NewLazyDLL("shell32.dll")
	procShellExecuteExW     = shell32Process.NewProc("ShellExecuteExW")
	kernel32Process         = syscall.NewLazyDLL("kernel32.dll")
	procWaitForSingleObject = kernel32Process.NewProc("WaitForSingleObject")
	procGetExitCodeProcess  = kernel32Process.NewProc("GetExitCodeProcess")
	procCloseHandle         = kernel32Process.NewProc("CloseHandle")
)

func shellExecuteAndWait(path string, args []string, timeout time.Duration) processResult {
	if path == "" {
		return processResult{ExitCode: 9009, Stderr: "Executable not found."}
	}
	if err := validateArgs(args); err != nil {
		return processResult{ExitCode: 87, Stderr: err.Error()}
	}
	verb, _ := syscall.UTF16PtrFromString("open")
	file, err := syscall.UTF16PtrFromString(path)
	if err != nil {
		return processResult{ExitCode: 87, Stderr: err.Error()}
	}
	parts := make([]string, 0, len(args))
	for _, arg := range args {
		parts = append(parts, syscall.EscapeArg(arg))
	}
	parameters, err := syscall.UTF16PtrFromString(strings.Join(parts, " "))
	if err != nil {
		return processResult{ExitCode: 87, Stderr: err.Error()}
	}
	info := shellExecuteInfo{
		FMask:      seeMaskNoCloseProcess,
		Verb:       verb,
		File:       file,
		Parameters: parameters,
		NShow:      swShowNormal,
	}
	info.CbSize = uint32(unsafe.Sizeof(info))
	r, _, callErr := procShellExecuteExW.Call(uintptr(unsafe.Pointer(&info)))
	if r == 0 || info.Process == 0 {
		return processResult{ExitCode: 740, Stderr: fmt.Sprintf("ShellExecuteEx failed: %v", callErr)}
	}
	defer procCloseHandle.Call(info.Process)

	waitMs := uint32(0xffffffff)
	if timeout > 0 {
		ms := timeout / time.Millisecond
		if ms < 1 {
			ms = 1
		}
		if ms < time.Duration(0xffffffff) {
			waitMs = uint32(ms)
		}
	}
	waitResult, _, waitErr := procWaitForSingleObject.Call(info.Process, uintptr(waitMs))
	if waitResult == waitTimeout {
		return processResult{ExitCode: 1460, Stderr: "Process is still running.", TimedOut: true}
	}
	if waitResult != waitObject0 {
		return processResult{ExitCode: 1, Stderr: fmt.Sprintf("WaitForSingleObject failed: %v", waitErr)}
	}
	var code uint32
	r, _, codeErr := procGetExitCodeProcess.Call(info.Process, uintptr(unsafe.Pointer(&code)))
	if r == 0 {
		return processResult{ExitCode: 1, Stderr: fmt.Sprintf("GetExitCodeProcess failed: %v", codeErr)}
	}
	return processResult{ExitCode: int(code)}
}
