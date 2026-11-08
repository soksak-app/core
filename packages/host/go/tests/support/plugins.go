package support

import (
	"archive/tar"
	"bytes"
	"compress/gzip"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"os"
	"path/filepath"
	"runtime"
	"sync"
	"testing"

	host "github.com/soksak-app/core/packages/host/go/src"
	sok "github.com/soksak-app/core/packages/sok/go/src"
)

// WriteInstalled writes the content for each path into the configuration folder.
func WriteInstalled(t *testing.T, config string, files map[string]string) {
	t.Helper()
	for name, content := range files {
		file := filepath.Join(config, filepath.FromSlash(name))
		if err := os.MkdirAll(filepath.Dir(file), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(file, []byte(content), 0o644); err != nil {
			t.Fatal(err)
		}
	}
}

// sokJSON runs the sok command and returns its JSON output.
func sokJSON(t *testing.T, args ...string) map[string]any {
	t.Helper()
	var stdout, stderr bytes.Buffer
	if code := sok.Run(args, &stdout, &stderr, sok.Options{Identifier: "com.soksak.test", PathsDir: t.TempDir(), CoreVersion: sok.CoreVersion}); code != 0 {
		t.Fatalf("sok %v: code %d stderr %s", args, code, stderr.String())
	}
	var value map[string]any
	if err := json.Unmarshal(stdout.Bytes(), &value); err != nil {
		t.Fatalf("sok %v: %v", args, err)
	}
	return value
}

// probeFixture is the folder of fixtures/plugin-probe of the tests of the Go language host library. It is found from the source of
// this package, so a test package in any folder below tests reads the same fixture.
func probeFixture() string {
	_, here, _, _ := runtime.Caller(0)
	return filepath.Join(filepath.Dir(here), "..", "fixtures", "plugin-probe")
}

// packFixture writes the release of fixtures/plugin-probe in the layout that `pnpm pack` writes
// (docs/spec/installation.md#plugin-release), with the two files of the fixture under `package/`, into dir, and returns
// its path and sha256.
func packFixture(t *testing.T, dir string) (string, string) {
	t.Helper()
	var data bytes.Buffer
	zipped := gzip.NewWriter(&data)
	release := tar.NewWriter(zipped)
	for _, name := range []string{"package.json", "plugin.json"} {
		content, err := os.ReadFile(filepath.Join(probeFixture(), name))
		if err != nil {
			t.Fatal(err)
		}
		if err := release.WriteHeader(&tar.Header{Typeflag: tar.TypeReg, Name: "package/" + name, Mode: 0o644, Size: int64(len(content))}); err != nil {
			t.Fatal(err)
		}
		if _, err := release.Write(content); err != nil {
			t.Fatal(err)
		}
	}
	if err := release.Close(); err != nil {
		t.Fatal(err)
	}
	if err := zipped.Close(); err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(dir, "plugin-probe-"+sok.CoreVersion+".tgz")
	if err := os.WriteFile(path, data.Bytes(), 0o644); err != nil {
		t.Fatal(err)
	}
	sum := sha256.Sum256(data.Bytes())
	return path, hex.EncodeToString(sum[:])
}

// PluginRegistry builds the current release of fixtures/plugin-probe and its registry, and returns the paths of index.json and the
// release.
func PluginRegistry(t *testing.T) (index, release string) {
	t.Helper()
	version := sok.CoreVersion
	releases, registry := t.TempDir(), t.TempDir()
	release, sum := packFixture(t, releases)
	WriteInstalled(t, registry, map[string]string{
		"plugins/probe.json": `{"id": "probe", "package": "plugin-probe", "name": "Probe", "description": "검사용 plugin.",
			"license": "MIT", "repository": "https://example.invalid/probe", "versions": [{"version": "` + version + `",
			"release": {"url": "file://` + release + `", "sha256": "` + sum + `"},
			"engines": {"soksak": ">=0.0.1 <1.0.0"}, "sidecars": {}}]}`,
		"revoked.json": `{"plugins": [], "sidecars": []}`,
	})
	sokJSON(t, "registry", "build", registry)
	return filepath.Join(registry, "index.json"), release
}

// Changes collects the plugins-changed notifications.
type Changes struct {
	mu   sync.Mutex
	seen []host.PluginsChanged
}

// Add records change.
func (c *Changes) Add(change host.PluginsChanged) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.seen = append(c.seen, change)
}

// List returns the recorded changes in their order.
func (c *Changes) List() []host.PluginsChanged {
	c.mu.Lock()
	defer c.mu.Unlock()
	return append([]host.PluginsChanged(nil), c.seen...)
}

// NewPlugins starts the plugin operations of config and returns them with the record of their notifications.
func NewPlugins(t *testing.T, config string) (*host.Plugins, *Changes) {
	t.Helper()
	seen := &Changes{}
	plugins, err := host.NewPlugins(config, func() error { return nil }, seen.Add)
	if err != nil {
		t.Fatal(err)
	}
	return plugins, seen
}
