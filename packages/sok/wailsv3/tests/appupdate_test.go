package tests

// 애플리케이션 업데이트(docs/spec/installation.md#application-update)의 후보 선택과 release 준비를 검사한다.

import (
	"archive/zip"
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"slices"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/soksak-app/core/packages/sok/wailsv3/src"
	"github.com/soksak-app/core/packages/sok/wailsv3/src/platform"
)

// requireBundles skips a test of an operation on application bundles when the platform does not implement it.
func requireBundles(t *testing.T) {
	t.Helper()
	current, err := platform.Current()
	if err != nil {
		t.Fatal(err)
	}
	if _, err := current.BundleVersion(t.TempDir()); err != nil && strings.Contains(err.Error(), "not implemented on ") {
		t.Skip(err.Error())
	}
}

// coreIndex builds a checked index that lists the given core versions, each with a release for the key.
func coreIndex(t *testing.T, key string, revoked []string, versions ...string) *sok.Index {
	t.Helper()
	index := &sok.Index{Format: 1, Core: &sok.RegistryCore{}}
	for _, version := range versions {
		index.Core.Versions = append(index.Core.Versions, sok.CoreRelease{
			Version:  version,
			Releases: map[string]sok.Release{key: {URL: "file:///releases/" + version + ".zip", SHA256: strings.Repeat("a", 64)}},
		})
	}
	for _, version := range revoked {
		index.Revoked.Core = append(index.Revoked.Core, sok.RevokedCore{Version: version, Reason: "broken"})
	}
	return index
}

// contract: app-update.state.selects-the-candidate
func TestTheCandidateIsTheNewestListedCoreAfterTheRunningOneWithARelease(t *testing.T) {
	const key = "darwin-arm64-wailsv3"
	cases := []struct {
		name    string
		index   *sok.Index
		running string
		want    string
	}{
		{"the newest version", coreIndex(t, key, nil, "0.0.8", "0.0.9", "0.0.10"), "0.0.8", "0.0.10"},
		{"a revoked version is skipped", coreIndex(t, key, []string{"0.0.10"}, "0.0.9", "0.0.10"), "0.0.8", "0.0.9"},
		{"the running version is not an update", coreIndex(t, key, nil, "0.0.8"), "0.0.8", ""},
		{"an older version is not an update", coreIndex(t, key, nil, "0.0.7"), "0.0.8", ""},
		{"a version without a release for the key is skipped", coreIndex(t, "darwin-arm64-tauriv2", nil, "0.0.9"), "0.0.8", ""},
		{"an index without core lists none", &sok.Index{Format: 1}, "0.0.8", ""},
	}
	for _, c := range cases {
		got := sok.CoreUpdateCandidate(c.index, c.running, key)
		switch {
		case c.want == "" && got != nil:
			t.Fatalf("%s: the candidate is %s", c.name, got.Version)
		case c.want != "" && (got == nil || got.Version != c.want):
			t.Fatalf("%s: the candidate is %+v, want %s", c.name, got, c.want)
		}
	}
	got := sok.CoreUpdateCandidate(coreIndex(t, key, nil, "0.0.9"), "0.0.8", key)
	if got.Release.URL != "file:///releases/0.0.9.zip" || got.Release.SHA256 != strings.Repeat("a", 64) {
		t.Fatalf("the candidate release is %+v", got.Release)
	}
}

// bundleZip writes the zip of an application bundle whose Info.plist names the version, and returns its path and sha256.
func bundleZip(t *testing.T, version string) (path, sum string) {
	t.Helper()
	var buffer bytes.Buffer
	writer := zip.NewWriter(&buffer)
	plist := `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict><key>CFBundleShortVersionString</key><string>` + version + `</string></dict></plist>`
	for name, body := range map[string]string{"soksak.app/Contents/Info.plist": plist, "soksak.app/Contents/MacOS/soksak": "#!/bin/sh\n"} {
		file, err := writer.Create(name)
		if err != nil {
			t.Fatal(err)
		}
		if _, err := file.Write([]byte(body)); err != nil {
			t.Fatal(err)
		}
	}
	if err := writer.Close(); err != nil {
		t.Fatal(err)
	}
	path = filepath.Join(t.TempDir(), "soksak-"+version+"-darwin-arm64-wailsv3.zip")
	if err := os.WriteFile(path, buffer.Bytes(), 0o644); err != nil {
		t.Fatal(err)
	}
	hash := sha256.Sum256(buffer.Bytes())
	return path, hex.EncodeToString(hash[:])
}

// contract: app-update.stage.verifies-and-extracts
func TestStagingChecksTheHashExtractsTheBundleAndChecksItsVersion(t *testing.T) {
	requireBundles(t)
	config := t.TempDir()
	path, sum := bundleZip(t, "0.0.9")
	update := &sok.AppUpdate{Version: "0.0.9", Release: sok.Release{URL: "file://" + path, SHA256: sum}}
	bundle, err := sok.StageAppUpdate(config, update)
	if err != nil {
		t.Fatal(err)
	}
	if want := filepath.Join(config, "updates", "0.0.9", "soksak.app"); bundle != want {
		t.Fatalf("bundle %s, want %s", bundle, want)
	}
	if _, err := os.Stat(filepath.Join(bundle, "Contents", "MacOS", "soksak")); err != nil {
		t.Fatal(err)
	}
	// A staged folder that exists is replaced, so staging twice leaves one bundle.
	if err := os.WriteFile(filepath.Join(config, "updates", "0.0.9", "stale"), []byte("x"), 0o644); err != nil {
		t.Fatal(err)
	}
	if _, err := sok.StageAppUpdate(config, update); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(filepath.Join(config, "updates", "0.0.9", "stale")); !os.IsNotExist(err) {
		t.Fatalf("a second staging kept the earlier folder: %v", err)
	}
}

// contract: app-update.stage.rejects-a-wrong-release
func TestStagingRejectsAWrongHashAndAWrongBundleVersion(t *testing.T) {
	requireBundles(t)
	config := t.TempDir()
	path, sum := bundleZip(t, "0.0.9")
	wrongHash := &sok.AppUpdate{Version: "0.0.9", Release: sok.Release{URL: "file://" + path, SHA256: strings.Repeat("0", 64)}}
	if _, err := sok.StageAppUpdate(config, wrongHash); err == nil || !strings.Contains(err.Error(), "has sha256 "+sum) {
		t.Fatalf("a wrong hash: %v", err)
	}
	other, otherSum := bundleZip(t, "0.0.8")
	wrongVersion := &sok.AppUpdate{Version: "0.0.9", Release: sok.Release{URL: "file://" + other, SHA256: otherSum}}
	if _, err := sok.StageAppUpdate(config, wrongVersion); err == nil || !strings.Contains(err.Error(), "version is 0.0.8, not 0.0.9") {
		t.Fatalf("a wrong bundle version: %v", err)
	}
	if _, err := os.Stat(filepath.Join(config, "updates", "0.0.9")); !os.IsNotExist(err) {
		t.Fatalf("a rejected release left a staged folder: %v", err)
	}
	missing := &sok.AppUpdate{Version: "0.0.9", Release: sok.Release{URL: "file://" + filepath.Join(t.TempDir(), "none.zip"), SHA256: sum}}
	if _, err := sok.StageAppUpdate(config, missing); err == nil {
		t.Fatal("a missing release was staged")
	}
}

// fakeBundle writes a folder that looks like an application bundle and whose Info.plist holds text.
func fakeBundle(t *testing.T, parent, name, text string) string {
	t.Helper()
	bundle := filepath.Join(parent, name)
	if err := os.MkdirAll(filepath.Join(bundle, "Contents"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(bundle, "Contents", "Info.plist"), []byte(text), 0o644); err != nil {
		t.Fatal(err)
	}
	return bundle
}

// endingProcess starts a process and returns its pid and a function that ends it.
func endingProcess(t *testing.T) (int, func()) {
	t.Helper()
	command := exec.Command("sleep", "60")
	if err := command.Start(); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { command.Process.Kill(); command.Wait() })
	return command.Process.Pid, func() { command.Process.Kill(); command.Wait() }
}

// contract: app-update.replace.replaces-the-bundle-after-the-process-ended
func TestTheBundleIsReplacedAfterTheProcessEndedAndTheApplicationStarts(t *testing.T) {
	requireBundles(t)
	parent := t.TempDir()
	target := fakeBundle(t, parent, "soksak.app", "old")
	staged := fakeBundle(t, filepath.Join(parent, "updates", "0.0.9"), "soksak.app", "new")
	pid, end := endingProcess(t)
	var started []string
	open := func(bundle string, arguments []string) error {
		// The application starts after the process ended and the bundle was replaced.
		if err := exec.Command("kill", "-0", strconv.Itoa(pid)).Run(); err == nil {
			t.Error("the application started before the process ended")
		}
		data, err := os.ReadFile(filepath.Join(bundle, "Contents", "Info.plist"))
		if err != nil || string(data) != "new" {
			t.Errorf("the started bundle holds %q (%v)", data, err)
		}
		started = append(started, bundle+" "+strings.Join(arguments, " "))
		return nil
	}
	done := make(chan error, 1)
	go func() {
		done <- sok.ReplaceApp(sok.ReplaceOptions{PID: pid, Bundle: staged, Target: target, Arguments: []string{"--config-dir", "/config"}, Timeout: 30 * time.Second}, open)
	}()
	select {
	case err := <-done:
		t.Fatalf("the replacement finished while the process ran: %v", err)
	case <-time.After(300 * time.Millisecond):
	}
	end()
	if err := <-done; err != nil {
		t.Fatal(err)
	}
	if want := []string{target + " --config-dir /config"}; !slices.Equal(started, want) {
		t.Fatalf("started %v, want %v", started, want)
	}
	for _, gone := range []string{target + ".previous", target + ".new", staged} {
		if _, err := os.Stat(gone); !os.IsNotExist(err) {
			t.Fatalf("%s is left (%v)", gone, err)
		}
	}
}

// contract: app-update.replace.restores-the-bundle-when-the-start-fails
func TestTheEarlierBundleStartsAgainWhenTheNewOneFailsToStart(t *testing.T) {
	requireBundles(t)
	parent := t.TempDir()
	target := fakeBundle(t, parent, "soksak.app", "old")
	staged := fakeBundle(t, parent, "staged.app", "new")
	pid, end := endingProcess(t)
	end()
	var texts []string
	open := func(bundle string, arguments []string) error {
		data, _ := os.ReadFile(filepath.Join(bundle, "Contents", "Info.plist"))
		texts = append(texts, string(data))
		if len(texts) == 1 {
			return errors.New("the application cannot start")
		}
		return nil
	}
	err := sok.ReplaceApp(sok.ReplaceOptions{PID: pid, Bundle: staged, Target: target, Timeout: 30 * time.Second}, open)
	if err == nil || !strings.Contains(err.Error(), "the application cannot start") {
		t.Fatalf("the error is %v", err)
	}
	if !slices.Equal(texts, []string{"new", "old"}) {
		t.Fatalf("the started bundles held %v, want the new one and then the earlier one", texts)
	}
	data, _ := os.ReadFile(filepath.Join(target, "Contents", "Info.plist"))
	if string(data) != "old" {
		t.Fatalf("the target holds %q", data)
	}
}

// contract: app-update.replace.refuses-before-it-changes-anything
func TestTheReplacementRefusesWhatIsNotABundleOrWhenTheProcessKeepsRunning(t *testing.T) {
	requireBundles(t)
	parent := t.TempDir()
	staged := fakeBundle(t, parent, "staged.app", "new")
	pid, end := endingProcess(t)
	open := func(string, []string) error { t.Fatal("the application started"); return nil }
	notBundle := filepath.Join(parent, "plain")
	if err := os.MkdirAll(notBundle, 0o755); err != nil {
		t.Fatal(err)
	}
	for name, options := range map[string]sok.ReplaceOptions{
		"a target that is not a bundle": {PID: pid, Bundle: staged, Target: notBundle, Timeout: time.Second},
		"a missing bundle":              {PID: pid, Bundle: filepath.Join(parent, "none.app"), Target: fakeBundle(t, parent, "a.app", "old"), Timeout: time.Second},
		"the same bundle":               {PID: pid, Bundle: staged, Target: staged, Timeout: time.Second},
	} {
		if err := sok.ReplaceApp(options, open); err == nil {
			t.Fatalf("%s was accepted", name)
		}
	}
	// A process that keeps running past the timeout leaves the target as it was.
	target := fakeBundle(t, parent, "b.app", "old")
	err := sok.ReplaceApp(sok.ReplaceOptions{PID: pid, Bundle: staged, Target: target, Timeout: 200 * time.Millisecond}, open)
	if err == nil || !strings.Contains(err.Error(), "did not end within") {
		t.Fatalf("the process kept running: %v", err)
	}
	data, _ := os.ReadFile(filepath.Join(target, "Contents", "Info.plist"))
	if string(data) != "old" {
		t.Fatalf("the target holds %q", data)
	}
	end()
}
