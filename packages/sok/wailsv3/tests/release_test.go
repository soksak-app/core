package tests

// Checks the release and SHA256SUMS that sidecar release (docs/spec/cli.md) writes.

import (
	"archive/tar"
	"compress/gzip"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"io"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// writeTree writes the content of each path. A name that ends with * gets the executable bit.
func writeTree(t *testing.T, dir string, files map[string]string) {
	t.Helper()
	for name, content := range files {
		mode := os.FileMode(0o644)
		if strings.HasSuffix(name, "*") {
			name, mode = strings.TrimSuffix(name, "*"), 0o755
		}
		path := filepath.Join(dir, filepath.FromSlash(name))
		if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(path, []byte(content), mode); err != nil {
			t.Fatal(err)
		}
	}
}

type tarEntry struct {
	name  string
	mode  int64
	time  int64
	owner int
}

func readRelease(t *testing.T, path string) ([]tarEntry, string) {
	t.Helper()
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	sum := sha256.Sum256(data)
	file, err := os.Open(path)
	if err != nil {
		t.Fatal(err)
	}
	defer file.Close()
	zipped, err := gzip.NewReader(file)
	if err != nil {
		t.Fatal(err)
	}
	reader := tar.NewReader(zipped)
	var entries []tarEntry
	for {
		header, err := reader.Next()
		if err == io.EOF {
			break
		}
		if err != nil {
			t.Fatal(err)
		}
		entries = append(entries, tarEntry{header.Name, header.Mode, header.ModTime.Unix(), header.Uid + header.Gid})
	}
	return entries, hex.EncodeToString(sum[:])
}

func pluginTree(t *testing.T) string {
	dir := t.TempDir()
	writeTree(t, dir, map[string]string{
		"package.json": `{"name": "@scope/plugin-probe", "version": "0.2.0", "engines": {"soksak": "^0.0.2"},
			"files": ["plugin.json", "ui"]}`,
		"plugin.json":   `{"id": "probe", "name": "Probe", "description": "Sample.", "contributes": {"lib.point": [{"range": "^1.0.0", "module": "ui/b.js"}]}, "dependencies": {"@scope/sidecar-worker": "^0.1.0"}}`,
		"ui/b.js":       "b",
		"ui/a/run.sh*":  "run",
		"test/skip.mjs": "not listed",
	})
	return dir
}

func sidecarTree(t *testing.T, version string) string {
	dir := t.TempDir()
	writeTree(t, dir, map[string]string{
		"package.json":       `{"name": "@scope/sidecar-worker", "version": "` + version + `", "files": ["sidecar.json", "build/worker"]}`,
		"sidecar.json":       `{"executable": "build/worker", "protocol": 1, "displayName": "soksak://sidecar/probe"}`,
		"build/worker*":      "binary " + version,
		"build/intermediate": "not listed",
	})
	return dir
}

// contract: cli.release.requires-display-name
func TestSidecarReleaseRejectsAMissingDisplayName(t *testing.T) {
	out := t.TempDir()
	root := sidecarTree(t, "0.1.0")
	if err := os.WriteFile(filepath.Join(root, "sidecar.json"), []byte(`{"executable":"build/worker","protocol":1}`), 0o644); err != nil {
		t.Fatal(err)
	}
	code, _, stderr := run("sidecar", "release", root, out, "--platform", "darwin-arm64")
	if code != 1 || stderr != "sok: sidecar.json: displayName is required\n" {
		t.Fatalf("code %d stderr %q", code, stderr)
	}
	if entries, err := os.ReadDir(out); err != nil || len(entries) != 0 {
		t.Fatalf("failed release wrote output: %v, %v", entries, err)
	}
}

// contract: cli.release.writes-release-and-sums
func TestSidecarReleaseWritesTheAssetAndKeepsSHA256SUMSSorted(t *testing.T) {
	out := t.TempDir()
	var sums []string
	for _, item := range [][2]string{{"0.1.1", "linux-x64"}, {"0.1.0", "darwin-arm64"}, {"0.1.1", "linux-x64"}} {
		code, stdout, stderr := run("sidecar", "release", sidecarTree(t, item[0]), out, "--platform", item[1])
		if code != 0 {
			t.Fatalf("code %d stderr %q", code, stderr)
		}
		var result map[string]string
		if err := json.Unmarshal([]byte(stdout), &result); err != nil {
			t.Fatal(err)
		}
		name := "scope-sidecar-worker-" + item[0] + "-" + item[1] + ".tar.gz"
		entries, sum := readRelease(t, filepath.Join(out, name))
		if result["release"] != filepath.Join(out, name) || result["sha256"] != sum || result["platform"] != item[1] ||
			result["name"] != "@scope/sidecar-worker" || result["version"] != item[0] {
			t.Fatalf("result %v", result)
		}
		if len(entries) != 3 || entries[0].name != "build/worker" || entries[0].mode != 0o755 || entries[2].name != "sidecar.json" {
			t.Fatalf("entries %v", entries)
		}
		// The writer sets time 0 and owner 0, so the same files give the same bytes.
		for _, entry := range entries {
			if entry.time != 0 || entry.owner != 0 {
				t.Fatalf("entries %v", entries)
			}
		}
		sums = append(sums, sum+"  "+name)
	}
	// A third release of the same name changes the first line, and the lines are in the order of release names.
	data, err := os.ReadFile(filepath.Join(out, "SHA256SUMS"))
	if err != nil || string(data) != sums[1]+"\n"+sums[2]+"\n" {
		t.Fatalf("SHA256SUMS %q %v", data, err)
	}
	code, _, stderr := run("sidecar", "release", sidecarTree(t, "0.1.0"), out, "--platform", "solaris-sparc")
	if code != 2 || !strings.HasPrefix(stderr, "sok: --platform: unknown platform solaris-sparc\n") {
		t.Fatalf("code %d stderr %q", code, stderr)
	}
	unlisted := sidecarTree(t, "0.1.0")
	writeTree(t, unlisted, map[string]string{"package.json": `{"name": "@scope/sidecar-worker", "version": "0.1.0", "files": ["sidecar.json"]}`})
	code, _, stderr = run("sidecar", "release", unlisted, out, "--platform", "darwin-arm64")
	if code != 1 || stderr != "sok: package.json files: build/worker is not listed\n" {
		t.Fatalf("code %d stderr %q", code, stderr)
	}
	writeTree(t, out, map[string]string{"SHA256SUMS": "broken\n"})
	code, _, stderr = run("sidecar", "release", sidecarTree(t, "0.2.0"), out, "--platform", "darwin-arm64")
	if code != 1 || stderr != "sok: "+filepath.Join(out, "SHA256SUMS")+" line 1 is not \"<sha256>  <release name>\"\n" {
		t.Fatalf("code %d stderr %q", code, stderr)
	}
	if _, err := os.Stat(filepath.Join(out, "scope-sidecar-worker-0.2.0-darwin-arm64.tar.gz")); !os.IsNotExist(err) {
		t.Fatalf("a failed release left its release: %v", err)
	}
}

// contract: cli.release.requires-the-replay-executable
func TestSidecarReleaseRefusesAReplayExecutableThatThePackageDoesNotShip(t *testing.T) {
	out := t.TempDir()
	missing := sidecarTree(t, "0.1.0")
	writeTree(t, missing, map[string]string{
		"sidecar.json":  `{"executable": "build/worker", "displayName":"soksak://sidecar/probe","protocol": 1, "replay": {"role": "screen", "executable": "build/replay"}}`,
		"build/replay*": "binary replay",
	})
	code, _, stderr := run("sidecar", "release", missing, out, "--platform", "darwin-arm64")
	if code != 1 || stderr != "sok: package.json files: build/replay, the replay executable of sidecar.json, is not listed\n" {
		t.Fatalf("code %d stderr %q", code, stderr)
	}
	if _, err := os.Stat(filepath.Join(out, "scope-sidecar-worker-0.1.0-darwin-arm64.tar.gz")); !os.IsNotExist(err) {
		t.Fatalf("a refused release left its release: %v", err)
	}
	writeTree(t, missing, map[string]string{
		"package.json": `{"name": "@scope/sidecar-worker", "version": "0.1.0", "files": ["sidecar.json", "build/worker", "build/replay"]}`,
	})
	if code, _, stderr = run("sidecar", "release", missing, out, "--platform", "darwin-arm64"); code != 0 {
		t.Fatalf("a release that ships its replay executable failed with code %d: %q", code, stderr)
	}
	writeTree(t, missing, map[string]string{
		"sidecar.json": `{"executable": "build/worker", "displayName":"soksak://sidecar/probe","protocol": 1, "replay": {"role": "screen"}}`,
	})
	code, _, stderr = run("sidecar", "release", missing, out, "--platform", "darwin-arm64")
	if code != 1 || stderr != "sok: sidecar.json: replay.executable is required\n" {
		t.Fatalf("code %d stderr %q", code, stderr)
	}
}
