package host_test

import (
	"archive/zip"
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"

	host "github.com/soksak-app/core/packages/host/wailsv3/src"
	sok "github.com/soksak-app/core/packages/sok/wailsv3/src"
)

// updateRegistry writes a registry index that lists core 0.0.9 with a release for the key, and a configuration directory
// that uses it; it returns the directory.
func updateRegistry(t *testing.T, key string) string {
	t.Helper()
	var buffer bytes.Buffer
	writer := zip.NewWriter(&buffer)
	for name, body := range map[string]string{
		"soksak.app/Contents/Info.plist": `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict><key>CFBundleShortVersionString</key><string>0.0.9</string></dict></plist>`,
		"soksak.app/Contents/MacOS/soksak": "#!/bin/sh\n",
	} {
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
	releases := t.TempDir()
	zipPath := filepath.Join(releases, "soksak-0.0.9-"+key+".zip")
	if err := os.WriteFile(zipPath, buffer.Bytes(), 0o644); err != nil {
		t.Fatal(err)
	}
	sum := sha256.Sum256(buffer.Bytes())
	index := `{"format": 1, "plugins": [], "sidecars": [], "core": {"versions": [{"version": "0.0.9", "releases": {"` + key +
		`": {"url": "file://` + zipPath + `", "sha256": "` + hex.EncodeToString(sum[:]) + `"}}}]}, "packs": [], "revoked": {"plugins": [], "sidecars": []}}`
	indexPath := filepath.Join(releases, "index.json")
	if err := os.WriteFile(indexPath, []byte(index), 0o644); err != nil {
		t.Fatal(err)
	}
	config := t.TempDir()
	if _, err := sok.UseRegistry(config, indexPath, sok.DefaultFetcher); err != nil {
		t.Fatal(err)
	}
	return config
}

// contract: app-update.host.stages-only-the-candidate
func TestTheHostStagesTheCandidateAndNoOtherVersion(t *testing.T) {
	const key = "darwin-arm64-wailsv3"
	config := updateRegistry(t, key)
	state, err := host.ReadAppUpdateState(config, "0.0.8", key)
	if err != nil {
		t.Fatal(err)
	}
	if state.Version != "0.0.8" || state.Available == nil || state.Available.Version != "0.0.9" {
		t.Fatalf("the state is %+v", state)
	}
	if _, err := host.StageAppUpdate(config, "0.0.8", key, "0.0.10"); err == nil || !strings.Contains(err.Error(), "0.0.10 is not the candidate") {
		t.Fatalf("a version that is not the candidate: %v", err)
	}
	bundle, err := host.StageAppUpdate(config, "0.0.8", key, "0.0.9")
	if err != nil {
		t.Fatal(err)
	}
	if want := filepath.Join(config, "updates", "0.0.9", "soksak.app"); bundle != want {
		t.Fatalf("bundle %s, want %s", bundle, want)
	}
	// The running version has no candidate, so nothing is staged for it.
	if _, err := host.StageAppUpdate(config, "0.0.9", key, "0.0.9"); err == nil || !strings.Contains(err.Error(), "0.0.9 is not the candidate") {
		t.Fatalf("the running version: %v", err)
	}
}

// contract: app-update.apply.starts-sok-from-a-copy-and-checks-the-bundle
func TestTheUpdateStartsSokFromACopyBesideTheUpdatesAndChecksTheStagedBundle(t *testing.T) {
	config := t.TempDir()
	running := filepath.Join(t.TempDir(), "soksak.app")
	if err := os.MkdirAll(filepath.Join(running, "Contents", "MacOS"), 0o755); err != nil {
		t.Fatal(err)
	}
	executable := filepath.Join(running, "Contents", "MacOS", "soksak-wailsv3")
	if err := os.WriteFile(filepath.Join(running, "Contents", "MacOS", "sok"), []byte("#!/bin/sh\nexit 0\n"), 0o755); err != nil {
		t.Fatal(err)
	}
	staged := filepath.Join(config, "updates", "0.0.9", "soksak.app")
	if err := os.MkdirAll(filepath.Join(staged, "Contents"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(staged, "Contents", "Info.plist"), []byte("<plist/>"), 0o644); err != nil {
		t.Fatal(err)
	}
	command, err := host.PrepareAppUpdateStart(config, executable, staged, 4321, []string{"--config-dir", config})
	if err != nil {
		t.Fatal(err)
	}
	copied := filepath.Join(config, "updates", "sok")
	want := []string{copied, "app", "update", "--wait", "4321", "--bundle", staged, "--target", running, "--", "--config-dir", config}
	if command.Path != copied || !slices.Equal(command.Args[1:], want[1:]) {
		t.Fatalf("the command is %v, want %v", command.Args, want)
	}
	if info, err := os.Stat(copied); err != nil || info.Mode().Perm()&0o111 == 0 {
		t.Fatalf("the copy of sok is not executable: %v %v", info, err)
	}
	// A bundle outside the updates folder, a bundle without Info.plist and an application outside a bundle are refused.
	other := filepath.Join(t.TempDir(), "soksak.app")
	for name, args := range map[string][3]string{
		"a bundle outside updates":             {config, executable, other},
		"a staged folder that is not a bundle": {config, executable, filepath.Join(config, "updates", "0.0.9")},
		"an application outside a bundle":      {config, filepath.Join(t.TempDir(), "soksak-wailsv3"), staged},
	} {
		if _, err := host.PrepareAppUpdateStart(args[0], args[1], args[2], 4321, nil); err == nil {
			t.Fatalf("%s was accepted", name)
		}
	}
}
