//go:build windows

package main

import (
	"fmt"
	"strings"
	"syscall"
	"unsafe"
)

type guid struct {
	Data1 uint32
	Data2 uint16
	Data3 uint16
	Data4 [8]byte
}

type wintrustFileInfo struct {
	CbStruct     uint32
	_            uint32
	FilePath     *uint16
	File         uintptr
	KnownSubject uintptr
}

type wintrustData struct {
	CbStruct           uint32
	_                  uint32
	PolicyCallbackData uintptr
	SIPClientData      uintptr
	UIChoice           uint32
	RevocationChecks   uint32
	UnionChoice        uint32
	_2                 uint32
	FileInfo           uintptr
	StateAction        uint32
	_3                 uint32
	StateData          uintptr
	URLReference       uintptr
	ProvFlags          uint32
	UIContext          uint32
	SignatureSettings  uintptr
}

type cryptProviderSigner struct {
	CbStruct       uint32
	VerifyLow      uint32
	VerifyHigh     uint32
	CertChainCount uint32
	CertChain      uintptr
}

type cryptProviderCert struct {
	CbStruct uint32
	_        uint32
	Cert     uintptr
}

var (
	wintrust                           = syscall.NewLazyDLL("wintrust.dll")
	procWinVerifyTrust                 = wintrust.NewProc("WinVerifyTrust")
	procWTHelperProvDataFromStateData  = wintrust.NewProc("WTHelperProvDataFromStateData")
	procWTHelperGetProvSignerFromChain = wintrust.NewProc("WTHelperGetProvSignerFromChain")
	crypt32                            = syscall.NewLazyDLL("crypt32.dll")
	procCertGetNameStringW             = crypt32.NewProc("CertGetNameStringW")
)

const (
	wtdUINone            = 2
	wtdRevokeNone        = 0
	wtdChoiceFile        = 1
	wtdStateActionVerify = 1
	wtdStateActionClose  = 2
	certNameAttrType     = 3
)

var genericVerifyV2 = guid{
	Data1: 0x00AAC56B,
	Data2: 0xCD44,
	Data3: 0x11D0,
	Data4: [8]byte{0x8C, 0xC2, 0x00, 0xC0, 0x4F, 0xC2, 0x95, 0xEE},
}

func verifyDockerAuthenticode(path string) (string, error) {
	filePath, err := syscall.UTF16PtrFromString(path)
	if err != nil {
		return "", err
	}
	fileInfo := wintrustFileInfo{FilePath: filePath}
	fileInfo.CbStruct = uint32(unsafe.Sizeof(fileInfo))
	data := wintrustData{
		UIChoice:         wtdUINone,
		RevocationChecks: wtdRevokeNone,
		UnionChoice:      wtdChoiceFile,
		FileInfo:         uintptr(unsafe.Pointer(&fileInfo)),
		StateAction:      wtdStateActionVerify,
	}
	data.CbStruct = uint32(unsafe.Sizeof(data))

	result, _, _ := procWinVerifyTrust.Call(0, uintptr(unsafe.Pointer(&genericVerifyV2)), uintptr(unsafe.Pointer(&data)))
	if int32(result) != 0 {
		return "", fmt.Errorf("WinVerifyTrust failed: 0x%08x", uint32(result))
	}
	defer func() {
		data.StateAction = wtdStateActionClose
		procWinVerifyTrust.Call(0, uintptr(unsafe.Pointer(&genericVerifyV2)), uintptr(unsafe.Pointer(&data)))
	}()

	if data.StateData == 0 {
		return "", fmt.Errorf("signature state unavailable")
	}
	prov, _, _ := procWTHelperProvDataFromStateData.Call(data.StateData)
	if prov == 0 {
		return "", fmt.Errorf("signature provider data unavailable")
	}
	signerPtr, _, _ := procWTHelperGetProvSignerFromChain.Call(prov, 0, 0, 0)
	if signerPtr == 0 {
		return "", fmt.Errorf("signature signer unavailable")
	}
	signer := (*cryptProviderSigner)(unsafe.Pointer(signerPtr))
	if signer.CertChainCount == 0 || signer.CertChain == 0 {
		return "", fmt.Errorf("signature certificate chain unavailable")
	}
	cert := (*cryptProviderCert)(unsafe.Pointer(signer.CertChain))
	if cert.Cert == 0 {
		return "", fmt.Errorf("signer certificate unavailable")
	}

	// OID 2.5.4.10 is the X.509 Organization Name attribute.
	oid, _ := syscall.BytePtrFromString("2.5.4.10")
	needed, _, _ := procCertGetNameStringW.Call(cert.Cert, certNameAttrType, 0, uintptr(unsafe.Pointer(oid)), 0, 0)
	if needed <= 1 {
		return "", fmt.Errorf("signer organization unavailable")
	}
	buf := make([]uint16, int(needed))
	written, _, _ := procCertGetNameStringW.Call(cert.Cert, certNameAttrType, 0, uintptr(unsafe.Pointer(oid)), uintptr(unsafe.Pointer(&buf[0])), needed)
	if written <= 1 {
		return "", fmt.Errorf("signer organization unavailable")
	}
	organization := strings.TrimSpace(syscall.UTF16ToString(buf))
	if !strings.EqualFold(organization, "Docker Inc") && !strings.EqualFold(organization, "Docker Inc.") {
		return organization, fmt.Errorf("unexpected signer organization: %s", organization)
	}
	return organization, nil
}
