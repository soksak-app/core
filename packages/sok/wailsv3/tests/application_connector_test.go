package tests

// Checks that installing a connector plugin connects its application (docs/spec/installation.md#applications): the
// installer tries the locate entries of the platform it runs on and records an application it finds without installing
// anything, refuses a platform that the application does not support with installed.json unchanged, and removing the
// plugin removes the entry of a located application and leaves the application itself.

import (
	"encoding/json"
	"path/filepath"
	"strings"
	"testing"

	"github.com/soksak-app/core/packages/sok/wailsv3/src"
)

// connectorRegistry builds a registry with one release of the connector plugin probe whose plugin.json declares the
// application, and returns the folder of the registry.
func connectorRegistry(t *testing.T, application map[string]any) string {
	t.Helper()
	releases := t.TempDir()
	declared, err := json.Marshal(application)
	if err != nil {
		t.Fatal(err)
	}
	dir := t.TempDir()
	writeTree(t, dir, map[string]string{
		"package.json": `{"name": "@scope/plugin-probe", "version": "0.1.0", "engines": {"soksak": "^0.0.2"}, "files": ["plugin.json"]}`,
		"plugin.json":  `{"id": "probe", "name": "Probe", "description": "Connects an application.", "application": ` + string(declared) + `}`,
	})
	result := runJSON(t, "plugin", "pack", dir, releases)
	registry := t.TempDir()
	writeTree(t, registry, map[string]string{
		"plugins/probe.json": `{"id": "probe", "package": "@scope/plugin-probe", "name": "Probe", "description": "검사용 plugin.",
			"license": "MIT", "repository": "https://example.invalid/probe", "versions": [{"version": "0.1.0",
			"release": {"url": "file://` + result["release"] + `", "sha256": "` + result["sha256"] + `"}, "engines": {"soksak": "^0.0.2"}, "sidecars": {}}]}`,
		"revoked.json": `{"plugins": [], "sidecars": []}`,
	})
	runJSON(t, "registry", "build", registry)
	return registry
}

// sketcher is an application whose only platform entry finds an executable at path and whose recipe is never run.
func sketcher(platform, path string) map[string]any {
	return map[string]any{"id": "sketcher", "name": "Sketcher", "version": "1.0.0", "platforms": map[string]any{
		platform: map[string]any{
			"locate":  []any{map[string]any{"path": path}},
			"recipe":  map[string]any{"kind": "release", "url": "https://example.invalid/sketcher.zip", "sha256": strings.Repeat("a", 64), "unpack": "zip"},
			"program": "sketcher",
		},
	}}
}

// contract: application.connector.connects-installed
func TestInstallingAConnectorConnectsAnApplicationThatIsInstalled(t *testing.T) {
	platform := mustPlatform(t)
	present := filepath.Join(t.TempDir(), "sketcher")
	executable(t, present)
	config := t.TempDir()
	useRegistry(t, config, connectorRegistry(t, sketcher(platform, present)))
	succeeds(t, "plugin", "install", "probe", "--config-dir", config)
	applications, err := sok.ReadApplications(config)
	if err != nil {
		t.Fatal(err)
	}
	want := sok.ApplicationRecord{Version: "1.0.0", Path: present, How: "located", Method: "path"}
	if applications.Applications["sketcher"] != want {
		t.Fatalf("applications %+v", applications.Applications)
	}
	if exists(filepath.Join(config, "applications")) {
		t.Fatal("a located application was installed")
	}
	succeeds(t, "plugin", "remove", "probe", "--config-dir", config)
	applications, err = sok.ReadApplications(config)
	if err != nil || len(applications.Applications) != 0 {
		t.Fatalf("applications after removal %+v %v", applications, err)
	}
	if !exists(present) {
		t.Fatal("removing the connector touched the located application")
	}
}

// contract: application.connector.refuses-other-platform
func TestAConnectorForAnotherPlatformIsRefusedAndChangesNothing(t *testing.T) {
	platform := mustPlatform(t)
	other := "windows-x64"
	if platform == other {
		other = "linux-x64"
	}
	config := t.TempDir()
	useRegistry(t, config, connectorRegistry(t, sketcher(other, "/nonexistent/sketcher")))
	code, _, stderr := run("plugin", "install", "probe", "--config-dir", config)
	if code == 0 || !strings.Contains(stderr, "application sketcher does not support "+platform) {
		t.Fatalf("code %d stderr %q", code, stderr)
	}
	if exists(filepath.Join(config, "plugins/installed.json")) || exists(filepath.Join(config, sok.Applications)) {
		t.Fatal("a refused connector changed the installation")
	}
}

// Each step of the connection reaches the observer of the operation, and the command line stores it in its event file.
// contract: application.connector.steps-observed-and-stored
func TestEachStepOfTheConnectionIsObservedAndStored(t *testing.T) {
	platform := mustPlatform(t)
	present := filepath.Join(t.TempDir(), "sketcher")
	executable(t, present)
	registry := connectorRegistry(t, sketcher(platform, present))

	config := t.TempDir()
	useRegistry(t, config, registry)
	var steps []sok.ApplicationStep
	if _, err := sok.RunPluginAction(config, "install", "probe", "0.0.2", platform, func(step sok.ApplicationStep) { steps = append(steps, step) }); err != nil {
		t.Fatal(err)
	}
	if len(steps) != 2 || steps[0].Step != "locate" || !steps[0].OK || steps[0].Method != "path" || steps[1].Step != "record" || !steps[1].OK {
		t.Fatalf("steps %+v", steps)
	}

	logged := t.TempDir()
	useRegistry(t, logged, registry)
	if code, _, stderr := loggedRun(logged, sok.Run, "plugin", "install", "probe"); code != 0 {
		t.Fatalf("code %d stderr %q", code, stderr)
	}
	stored := named(eventsOf(t, logged), "sok.application.step")
	if len(stored) != 2 || stored[0].Fields["step"] != "locate" || stored[0].Fields["method"] != "path" || stored[1].Fields["step"] != "record" {
		t.Fatalf("stored steps %+v", stored)
	}
}
