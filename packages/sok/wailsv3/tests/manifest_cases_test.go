package tests

import (
	"encoding/json"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"

	"github.com/soksak-app/core/packages/sok/wailsv3/tests/support"
)

// manifestCase is one case of the manifest case table that the plugin-api reader replays (docs/spec/installation.md#plugin-release).
type manifestCase struct {
	ID           string          `json:"id"`
	Manifest     json.RawMessage `json:"manifest"`
	Accepted     bool            `json:"accepted"`
	Error        string          `json:"error"`
	PackageFiles []string        `json:"packageFiles"`
}

// manifestCases reads the case table of docs/spec/cases, which no package owns.
func manifestCases(t *testing.T) []manifestCase {
	t.Helper()
	_, here, _, _ := runtime.Caller(0)
	data, err := os.ReadFile(filepath.Join(filepath.Dir(here), "..", "..", "..", "..", "docs", "spec", "cases", "manifest-validation.json"))
	if err != nil {
		t.Fatal(err)
	}
	var table struct {
		Cases []manifestCase `json:"cases"`
	}
	if err := json.Unmarshal(data, &table); err != nil {
		t.Fatal(err)
	}
	if len(table.Cases) == 0 {
		t.Fatal("the manifest case table holds no case")
	}
	return table.Cases
}

// indexForRelease writes a registry index whose plugin probe 0.2.0 is the release at path with sum, and returns its path.
func indexForRelease(t *testing.T, path, sum string) string {
	t.Helper()
	dir := t.TempDir()
	writeTree(t, dir, map[string]string{
		"index.json": jsonText(t, map[string]any{"format": 1, "sidecars": []any{}, "packs": []any{},
			"revoked": map[string]any{"plugins": []any{}, "sidecars": []any{}},
			"plugins": []any{map[string]any{"id": "probe", "package": "@scope/plugin-probe", "name": "Probe",
				"description": "검사용 plugin.", "license": "MIT", "repository": "https://example.invalid/probe",
				"versions": []any{map[string]any{"version": "0.2.0",
					"release": map[string]any{"url": "file://" + path, "sha256": sum},
					"engines": map[string]any{"soksak": "^0.0.2"}, "sidecars": map[string]any{}}}}}}),
	})
	return filepath.Join(dir, "index.json")
}

// contract: install.manifest.replays-manifest-cases
func TestPluginInstallReplaysTheManifestCases(t *testing.T) {
	for _, c := range manifestCases(t) {
		t.Run(c.ID, func(t *testing.T) {
			dir := t.TempDir()
			writeTree(t, dir, map[string]string{
				"package.json": jsonText(t, map[string]any{"name": "@scope/plugin-probe", "version": "0.2.0",
					"engines": map[string]any{"soksak": "^0.0.2"}, "files": c.PackageFiles}),
				"plugin.json": string(c.Manifest),
			})
			for _, file := range c.PackageFiles {
				if file != "plugin.json" {
					writeTree(t, dir, map[string]string{file: ""})
				}
			}
			release := support.PackRelease(t, dir, t.TempDir())
			config := t.TempDir()
			runJSON(t, "registry", "use", indexForRelease(t, release["release"], release["sha256"]), "--config-dir", config)
			code, _, stderr := run("plugin", "install", "probe", "--config-dir", config)
			installed := exists(filepath.Join(config, "plugins", "installed.json"))
			if c.Accepted {
				// The index holds no dependency of the plugin, so an accepted manifest with dependencies passes the
				// reader and stops at the dependency check of the registry.
				if !(code == 0 && installed) && !(code == 1 && strings.HasPrefix(stderr, "sok: probe 0.2.0: dependency ") && !installed) {
					t.Fatalf("install refused an accepted manifest: code %d stderr %q", code, stderr)
				}
				return
			}
			// Install parses plugin.json before the reader runs and refuses a value that is not an object with its
			// location; the reader text of that case names plugin.json itself.
			want := "sok: plugin probe 0.2.0 package: plugin.json: " + c.Error + "\n"
			var manifest map[string]any
			if json.Unmarshal(c.Manifest, &manifest) != nil {
				want = "sok: plugin probe 0.2.0 package: plugin.json: expected an object\n"
			}
			if code != 1 || stderr != want || installed {
				t.Fatalf("code %d stderr %q, want %q", code, stderr, want)
			}
		})
	}
}
