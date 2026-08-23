//go:build windows

package main

import (
	"fmt"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
	"time"
	"unsafe"
)

const (
	hkeyCurrentUser                 = 0x80000001
	hkeyLocalMachine                = 0x80000002
	keyRead                         = 0x20019
	regSZ                           = 1
	regExpandSZ                     = 2
	regDWORD                        = 4
	errorNoMoreItems                = 259
	pfSecondLevelAddressTranslation = 20
	pfVirtFirmwareEnabled           = 21
)

var (
	advapi32             = syscall.NewLazyDLL("advapi32.dll")
	procRegOpenKeyExW    = advapi32.NewProc("RegOpenKeyExW")
	procRegCloseKey      = advapi32.NewProc("RegCloseKey")
	procRegEnumKeyExW    = advapi32.NewProc("RegEnumKeyExW")
	procRegQueryValueExW = advapi32.NewProc("RegQueryValueExW")
	procRegDeleteValueW  = advapi32.NewProc("RegDeleteValueW")

	kernel32Win                   = syscall.NewLazyDLL("kernel32.dll")
	procIsProcessorFeaturePresent = kernel32Win.NewProc("IsProcessorFeaturePresent")
	procGetDiskFreeSpaceExW       = kernel32Win.NewProc("GetDiskFreeSpaceExW")
	procGetTickCount64            = kernel32Win.NewProc("GetTickCount64")

	shell32           = syscall.NewLazyDLL("shell32.dll")
	procIsUserAnAdmin = shell32.NewProc("IsUserAnAdmin")
)

type regKey uintptr

func openRegKeyAccess(root uintptr, path string, access uintptr) (regKey, error) {
	p, err := syscall.UTF16PtrFromString(path)
	if err != nil {
		return 0, err
	}
	var h uintptr
	r, _, _ := procRegOpenKeyExW.Call(root, uintptr(unsafe.Pointer(p)), 0, access, uintptr(unsafe.Pointer(&h)))
	if r != 0 {
		return 0, syscall.Errno(r)
	}
	return regKey(h), nil
}

func openRegKey(root uintptr, path string) (regKey, error) {
	return openRegKeyAccess(root, path, keyRead)
}
func (k regKey) close() {
	if k != 0 {
		procRegCloseKey.Call(uintptr(k))
	}
}

func regString(root uintptr, path, name string) (string, bool) {
	k, err := openRegKey(root, path)
	if err != nil {
		return "", false
	}
	defer k.close()
	n, _ := syscall.UTF16PtrFromString(name)
	var typ uint32
	var size uint32
	r, _, _ := procRegQueryValueExW.Call(uintptr(k), uintptr(unsafe.Pointer(n)), 0, uintptr(unsafe.Pointer(&typ)), 0, uintptr(unsafe.Pointer(&size)))
	if r != 0 || (typ != regSZ && typ != regExpandSZ) || size < 2 {
		return "", false
	}
	buf := make([]uint16, int(size/2)+1)
	r, _, _ = procRegQueryValueExW.Call(uintptr(k), uintptr(unsafe.Pointer(n)), 0, uintptr(unsafe.Pointer(&typ)), uintptr(unsafe.Pointer(&buf[0])), uintptr(unsafe.Pointer(&size)))
	if r != 0 {
		return "", false
	}
	value := syscall.UTF16ToString(buf)
	if typ == regExpandSZ {
		value = os.ExpandEnv(value)
	}
	return value, true
}

func regDWORDValue(root uintptr, path, name string) (uint32, bool) {
	k, err := openRegKey(root, path)
	if err != nil {
		return 0, false
	}
	defer k.close()
	n, _ := syscall.UTF16PtrFromString(name)
	var typ uint32
	var value uint32
	size := uint32(4)
	r, _, _ := procRegQueryValueExW.Call(uintptr(k), uintptr(unsafe.Pointer(n)), 0, uintptr(unsafe.Pointer(&typ)), uintptr(unsafe.Pointer(&value)), uintptr(unsafe.Pointer(&size)))
	if r != 0 || typ != regDWORD || size != 4 {
		return 0, false
	}
	return value, true
}

func regSubkeys(root uintptr, path string) []string {
	k, err := openRegKey(root, path)
	if err != nil {
		return nil
	}
	defer k.close()
	var out []string
	for index := uint32(0); ; index++ {
		buf := make([]uint16, 512)
		size := uint32(len(buf))
		r, _, _ := procRegEnumKeyExW.Call(uintptr(k), uintptr(index), uintptr(unsafe.Pointer(&buf[0])), uintptr(unsafe.Pointer(&size)), 0, 0, 0, 0)
		if r == errorNoMoreItems {
			break
		}
		if r != 0 {
			break
		}
		out = append(out, syscall.UTF16ToString(buf[:size]))
	}
	return out
}

func regDeleteValue(root uintptr, path, name string) {
	k, err := openRegKeyAccess(root, path, syscall.KEY_SET_VALUE)
	if err != nil {
		return
	}
	defer k.close()
	n, _ := syscall.UTF16PtrFromString(name)
	procRegDeleteValueW.Call(uintptr(k), uintptr(unsafe.Pointer(n)))
}

func isAdministrator() bool {
	r, _, _ := procIsUserAnAdmin.Call()
	return r != 0
}

func processorFeature(feature uintptr) bool {
	r, _, _ := procIsProcessorFeaturePresent.Call(feature)
	return r != 0
}

func bootID() string {
	ticks, _, _ := procGetTickCount64.Call()
	bootUnix := time.Now().Unix() - int64(uint64(ticks)/1000)
	bootUnix = (bootUnix / 10) * 10
	return strconv.FormatInt(bootUnix, 10)
}

func systemDriveFreeGiB() float64 {
	root := filepath.VolumeName(os.Getenv("SystemRoot")) + `\`
	if root == `\` {
		root = `C:\`
	}
	p, err := syscall.UTF16PtrFromString(root)
	if err != nil {
		return -1
	}
	var free uint64
	r, _, _ := procGetDiskFreeSpaceExW.Call(uintptr(unsafe.Pointer(p)), uintptr(unsafe.Pointer(&free)), 0, 0)
	if r == 0 {
		return -1
	}
	value := float64(free) / (1024 * 1024 * 1024)
	return float64(int(value*10+0.5)) / 10
}

func nativeSystemExecutable(name string) string {
	if name == "" || strings.ContainsAny(name, `\\/:*?"<>|\r\n`) {
		return ""
	}
	systemRoot := os.Getenv("WINDIR")
	if systemRoot == "" {
		systemRoot = os.Getenv("SystemRoot")
	}
	if systemRoot == "" {
		systemRoot = `C:\Windows`
	}
	path := filepath.Join(systemRoot, "System32", name)
	if info, err := os.Stat(path); err == nil && !info.IsDir() {
		return path
	}
	return ""
}

func currentUserRebootPending(currentBootID string) bool {
	const key = `Software\NetWatch\Installer`
	requested, ok := regString(hkeyCurrentUser, key, "RebootRequiredBootId")
	if !ok || requested == "" {
		return false
	}
	if currentBootID != "" && requested != currentBootID {
		regDeleteValue(hkeyCurrentUser, key, "RebootRequiredBootId")
		return false
	}
	return currentBootID != ""
}

func runningInVM() bool {
	const bios = `HARDWARE\DESCRIPTION\System\BIOS`
	manufacturer, _ := regString(hkeyLocalMachine, bios, "SystemManufacturer")
	product, _ := regString(hkeyLocalMachine, bios, "SystemProductName")
	value := strings.ToLower(manufacturer + " " + product)
	markers := []string{"virtualbox", "vmware", "virtual machine", "kvm", "qemu", "parallels", "xen"}
	for _, marker := range markers {
		if strings.Contains(value, marker) {
			return true
		}
	}
	return false
}

func formatGiB(value float64) string {
	if value < 0 {
		return "-1"
	}
	return fmt.Sprintf("%.1f", value)
}
