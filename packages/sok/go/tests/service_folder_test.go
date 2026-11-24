package tests

import (
	"path/filepath"
	"strings"
	"testing"

	"github.com/soksak-app/core/packages/sok/go/src"
	"github.com/soksak-app/core/packages/sok/go/tests/support"
)

// The service folder of a persistent sidecar is named by the base name of its executable (docs/spec/persistent-services.md), so an
// installation refuses a second persistent sidecar whose executable has the base name of an installed one.

// serviceFolderRegistry builds a registry with the plugins one and two, which require the sidecars @scope/sidecar-one and
// @scope/sidecar-two; each sidecar names the executable build/worker with the transport of transports, and returns its folder.
func serviceFolderRegistry(t *testing.T, transports map[string]string) string {
	t.Helper()
	platform, err := sok.CurrentPlatform()
	if err != nil {
		t.Fatal(err)
	}
	releases := t.TempDir()
	registry := t.TempDir()
	files := map[string]string{"revoked.json": `{"plugins": [], "sidecars": []}`}
	for _, id := range []string{"one", "two"} {
		sidecar := "@scope/sidecar-" + id
		dir := t.TempDir()
		writeTree(t, dir, map[string]string{
			"package.json": `{"name": "@scope/plugin-` + id + `", "version": "1.0.0", "engines": {"soksak": "^0.0.2"}, "files": ["plugin.json"]}`,
			"plugin.json": `{"id": "` + id + `", "name": "Probe", "description": "Sample.", "contributes": {"lib.point": [{"range": "^1.0.0", "module": "ui/b.js"}]},
				"dependencies": {"` + sidecar + `": "^0.1.0"}}`,
		})
		plugin := support.PackRelease(t, dir, releases)
		files["plugins/"+id+".json"] = `{"id": "` + id + `", "package": "@scope/plugin-` + id + `", "name": "Probe", "description": "검사용 plugin.",
			"license": "MIT", "repository": "https://example.invalid/` + id + `", "versions": [{"version": "1.0.0",
			"release": {"url": "file://` + plugin["release"] + `", "sha256": "` + plugin["sha256"] + `"}, "engines": {"soksak": "^0.0.2"},
			"sidecars": {"` + sidecar + `": "^0.1.0"}}]}`
		transport := ""
		if transports[id] != "" {
			transport = `, "transport": "` + transports[id] + `"`
		}
		dir = t.TempDir()
		writeTree(t, dir, map[string]string{
			"package.json":  `{"name": "` + sidecar + `", "version": "0.1.0", "files": ["sidecar.json", "build/worker"]}`,
			"sidecar.json":  `{"executable": "build/worker", "protocol": 1, "displayName": "soksak://sidecar/` + id + `"` + transport + `}`,
			"build/worker*": "binary " + id,
		})
		release := support.PackRelease(t, dir, releases)
		files["sidecars/scope-sidecar-"+id+".json"] = `{"name": "` + sidecar + `", "repository": "https://example.invalid/` + id + `", "versions": [{"version": "0.1.0",
			"protocol": 1, "releases": {"` + platform + `": {"url": "file://` + release["release"] + `", "sha256": "` + release["sha256"] + `"}}}]}`
	}
	writeTree(t, registry, files)
	runJSON(t, "registry", "build", registry)
	return registry
}

// contract: cli.plugin.refuses-a-shared-service-folder
func TestAnInstallationRefusesASecondPersistentSidecarWithTheExecutableBaseNameOfAnother(t *testing.T) {
	config := t.TempDir()
	useRegistry(t, config, serviceFolderRegistry(t, map[string]string{"one": "persistent", "two": "persistent"}))
	succeeds(t, "plugin", "install", "one", "--config-dir", config)
	before := readText(t, filepath.Join(config, "plugins/installed.json"))
	code, stdout, stderr := run("plugin", "install", "two", "--config-dir", config)
	want := "sok: sidecar @scope/sidecar-two: executable base name worker is already the service folder of sidecar @scope/sidecar-one\n"
	if code != 1 || stdout != "" || stderr != want {
		t.Fatalf("the install of two: code %d stdout %q stderr %q, want %q", code, stdout, stderr, want)
	}
	if after := readText(t, filepath.Join(config, "plugins/installed.json")); after != before {
		t.Fatalf("installed.json changed to %s", after)
	}
	// A sidecar of standard I/O has no service folder, so it shares the base name.
	config = t.TempDir()
	useRegistry(t, config, serviceFolderRegistry(t, map[string]string{"one": "persistent"}))
	succeeds(t, "plugin", "install", "one", "--config-dir", config)
	if out := succeeds(t, "plugin", "install", "two", "--config-dir", config); !strings.Contains(out, `"version": "1.0.0"`) {
		t.Fatalf("the install of two printed %q", out)
	}
}
