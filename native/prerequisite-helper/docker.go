//go:build windows

package main

import (
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"time"
)

const (
	dockerDownloadURL                 = "https://desktop.docker.com/win/main/amd64/Docker%20Desktop%20Installer.exe"
	maximumDockerInstallerBytes int64 = 1610612736
)

func officialDockerURI(u *url.URL) bool {
	return u != nil && strings.EqualFold(u.Scheme, "https") && strings.EqualFold(u.Hostname(), "desktop.docker.com") && (u.Port() == "" || u.Port() == "443") && u.User == nil
}

func downloadDockerInstaller(sw *stateWriter) (string, error) {
	sw.setPhase("Downloading Docker Desktop")
	dir := filepath.Join(os.TempDir(), "NetWatchPrerequisites")
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return "", err
	}
	destination := filepath.Join(dir, "Docker Desktop Installer.exe")
	_ = os.Remove(destination)

	transport := &http.Transport{
		Proxy:                 http.ProxyFromEnvironment,
		TLSHandshakeTimeout:   30 * time.Second,
		ResponseHeaderTimeout: 2 * time.Minute,
		ExpectContinueTimeout: 5 * time.Second,
	}
	client := &http.Client{
		Transport: transport,
		Timeout:   30 * time.Minute,
		CheckRedirect: func(req *http.Request, via []*http.Request) error {
			if len(via) >= 5 {
				return fmt.Errorf("Docker download exceeded the redirect limit")
			}
			if !officialDockerURI(req.URL) {
				return fmt.Errorf("Docker download redirect left desktop.docker.com HTTPS")
			}
			return nil
		},
	}
	requestURL, err := url.Parse(dockerDownloadURL)
	if err != nil || !officialDockerURI(requestURL) {
		return "", fmt.Errorf("invalid Docker download URL")
	}
	resp, err := client.Get(requestURL.String())
	if err != nil {
		return "", err
	}
	defer resp.Body.Close()
	if !officialDockerURI(resp.Request.URL) {
		return "", fmt.Errorf("Docker response left desktop.docker.com HTTPS")
	}
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return "", fmt.Errorf("Docker download returned HTTP %d", resp.StatusCode)
	}
	if resp.ContentLength > maximumDockerInstallerBytes {
		return "", fmt.Errorf("Docker installer exceeds safety size limit")
	}

	out, err := os.OpenFile(destination, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0o600)
	if err != nil {
		return "", err
	}
	ok := false
	defer func() {
		out.Close()
		if !ok {
			_ = os.Remove(destination)
		}
	}()
	limited := &io.LimitedReader{R: resp.Body, N: maximumDockerInstallerBytes + 1}
	written, err := io.Copy(out, limited)
	if err != nil {
		return "", err
	}
	if written > maximumDockerInstallerBytes {
		return "", fmt.Errorf("Docker installer exceeds safety size limit")
	}
	if err := out.Sync(); err != nil {
		return "", err
	}
	if err := out.Close(); err != nil {
		return "", err
	}
	ok = true
	return destination, nil
}

func waitDockerEngine(timeout time.Duration) bool {
	deadline := time.Now().Add(timeout)
	for time.Now().Before(deadline) {
		cli := getDockerCLIExecutable()
		if cli != "" {
			result := runCaptured(cli, []string{"info", "--format", "{{.OSType}}"}, 8*time.Second, true)
			if result.ExitCode == 0 && strings.EqualFold(strings.TrimSpace(result.Stdout), "linux") {
				return true
			}
		}
		time.Sleep(2 * time.Second)
	}
	return false
}
