package tests

import (
	"encoding/json"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"

	"github.com/soksak-app/core/packages/sok/wailsv3/src"
)

// manifestCase is one case of the manifest case table that the plugin-api reader replays (docs/spec/installation.md#plugin-release).
type manifestCase struct {
	ID           string          `json:"id"`
	Manifest     json.RawMessage `json:"manifest"`
	Accepted     bool            `json:"accepted"`
	Error        string          `json:"error"`
	PackageFiles []string        `json:"packageFiles"`
}

// manifestCases reads the case table of packages/plugin-api/contract.
func manifestCases(t *testing.T) []manifestCase {
	t.Helper()
	_, here, _, _ := runtime.Caller(0)
	data, err := os.ReadFile(filepath.Join(filepath.Dir(here), "..", "..", "..", "plugin-api", "contract", "manifest-validation.json"))
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

// contract: cli.pack.replays-manifest-cases
func TestPluginPackReplaysTheManifestCases(t *testing.T) {
	for _, c := range manifestCases(t) {
		t.Run(c.ID, func(t *testing.T) {
			files := c.PackageFiles
			if len(files) == 0 {
				files = []string{"plugin.json"}
			}
			dir := t.TempDir()
			writeTree(t, dir, map[string]string{
				"package.json": jsonText(t, map[string]any{"name": "@scope/plugin-probe", "version": "0.2.0",
					"engines": map[string]any{"soksak": "^0.0.2"}, "files": files}),
				"plugin.json": string(c.Manifest),
			})
			for _, file := range files {
				if file != "plugin.json" {
					writeTree(t, dir, map[string]string{file: ""})
				}
			}
			code, _, stderr := run("plugin", "pack", dir, t.TempDir())
			if c.Accepted {
				if code != 0 {
					t.Fatalf("pack refused an accepted manifest: code %d stderr %q", code, stderr)
				}
				return
			}
			if code != 1 || stderr != "sok: "+c.Error+"\n" {
				t.Fatalf("code %d stderr %q, want %q", code, stderr, c.Error)
			}
		})
	}
}

// contract: install.manifest.replays-manifest-cases
func TestPluginInstallReplaysTheRefusedManifestCases(t *testing.T) {
	for _, c := range manifestCases(t) {
		// Installation checks the plugin id of the installation record before the manifest, so the cases of the id probe are
		// replayed here; the other cases are replayed by the pack test, which runs the same validation.
		var manifest map[string]any
		if c.Accepted || json.Unmarshal(c.Manifest, &manifest) != nil || manifest["id"] != "probe" {
			continue
		}
		t.Run(c.ID, func(t *testing.T) {
			index := schemaOutsideSubsetIndex(t)
			config := t.TempDir()
			runJSON(t, "registry", "use", index, "--config-dir", config)
			writeTree(t, filepath.Join(config, "plugins/probe/0.2.0"), map[string]string{
				"package.json": `{"name": "@scope/plugin-probe", "version": "0.2.0", "engines": {"soksak": "^0.0.2"}, "files": ["plugin.json"]}`,
				"plugin.json":  string(c.Manifest),
			})
			_, err := sok.RunPluginAction(config, "install", "probe", "0.0.2", mustPlatform(t))
			if err == nil || !strings.HasSuffix(err.Error(), "/plugin.json: "+c.Error) {
				t.Fatalf("error %v, want the plugin.json location and %q", err, c.Error)
			}
			if exists(filepath.Join(config, "plugins", "installed.json")) {
				t.Fatal("a refused install wrote installed.json")
			}
		})
	}
}
