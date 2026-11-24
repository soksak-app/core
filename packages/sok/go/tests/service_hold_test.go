package tests

// Checks that a plugin operation does not change the version of a persistent sidecar whose service runs
// (docs/spec/persistent-services.md#updates).

import (
	"encoding/json"
	"os/exec"
	"path/filepath"
	"reflect"
	"strings"
	"testing"

	"github.com/soksak-app/core/packages/sok/go/src"
	"github.com/soksak-app/core/packages/sok/go/tests/support"
)

const heldSidecar = "@scope/sidecar-worker"

// heldRegistry builds a registry in which probe 0.2.0 requires the persistent sidecar worker ^0.1.0 and probe 0.3.0 requires
// ^0.2.0, with releases of worker 0.1.0 and 0.2.0, and returns its folder.
func heldRegistry(t *testing.T, versions ...string) string {
	t.Helper()
	platform, err := sok.CurrentPlatform()
	if err != nil {
		t.Fatal(err)
	}
	ranges := map[string]string{"0.2.0": "^0.1.0", "0.3.0": "^0.2.0"}
	releases := t.TempDir()
	var entries []string
	for _, version := range versions {
		dir := t.TempDir()
		writeTree(t, dir, map[string]string{
			"package.json": `{"name": "@scope/plugin-probe", "version": "` + version + `", "engines": {"soksak": "^0.0.2"}, "files": ["plugin.json", "ui"]}`,
			"plugin.json": `{"id": "probe", "name": "Probe", "description": "Sample.", "contributes": {"lib.point": [{"range": "^1.0.0", "module": "ui/b.js"}]},
				"dependencies": {"` + heldSidecar + `": "` + ranges[version] + `"}}`,
			"ui/b.js": "b " + version,
		})
		result := support.PackRelease(t, dir, releases)
		entries = append(entries, `{"version": "`+version+`", "release": {"url": "file://`+result["release"]+`", "sha256": "`+result["sha256"]+`"},
			"engines": {"soksak": "^0.0.2"}, "sidecars": {"`+heldSidecar+`": "`+ranges[version]+`"}}`)
	}
	var sidecars []string
	for _, version := range []string{"0.1.0", "0.2.0"} {
		dir := t.TempDir()
		writeTree(t, dir, map[string]string{
			"package.json":  `{"name": "` + heldSidecar + `", "version": "` + version + `", "files": ["sidecar.json", "build/worker"]}`,
			"sidecar.json":  `{"executable": "build/worker", "protocol": 1, "displayName": "soksak://sidecar/probe", "transport": "persistent"}`,
			"build/worker*": "binary " + version,
		})
		release := support.PackRelease(t, dir, releases)
		sidecars = append(sidecars, `{"version": "`+version+`", "protocol": 1, "releases": {"`+platform+`": {"url": "file://`+release["release"]+`", "sha256": "`+release["sha256"]+`"}}}`)
	}
	registry := t.TempDir()
	writeTree(t, registry, map[string]string{
		"plugins/probe.json": `{"id": "probe", "package": "@scope/plugin-probe", "name": "Probe", "description": "검사용 plugin.",
			"license": "MIT", "repository": "https://example.invalid/probe", "versions": [` + strings.Join(entries, ",") + `]}`,
		"sidecars/scope-sidecar-worker.json": `{"name": "` + heldSidecar + `", "repository": "https://example.invalid/worker", "versions": [` + strings.Join(sidecars, ",") + `]}`,
		"revoked.json":                       `{"plugins": [], "sidecars": []}`,
	})
	runJSON(t, "registry", "build", registry)
	return registry
}

// startService publishes an endpoint of the service worker in config for a child process that runs until the check ends it, so
// the endpoint names its publisher; it returns the end of the child, after which the endpoint is stale.
func startService(t *testing.T, config string) func() {
	t.Helper()
	child := exec.Command("sleep", "60")
	if err := child.Start(); err != nil {
		t.Fatal(err)
	}
	ended := false
	end := func() {
		if ended {
			return
		}
		ended = true
		if err := child.Process.Kill(); err != nil {
			t.Fatal(err)
		}
		if err := child.Wait(); err == nil {
			t.Fatal("the killed service exited successfully")
		}
	}
	t.Cleanup(end)
	writeTree(t, config, map[string]string{
		"services/worker/endpoint.json": `{"protocol": 1, "pid": ` + jsonText(t, child.Process.Pid) + `, "socket": "/nowhere", "token": "t"}`,
	})
	return end
}

// contract: cli.plugin.update-waits-for-a-running-service
func TestAnUpdateThatChangesTheSidecarOfARunningServiceWritesNothing(t *testing.T) {
	config := t.TempDir()
	useRegistry(t, config, heldRegistry(t, "0.2.0"))
	succeeds(t, "plugin", "install", "probe", "--config-dir", config)
	end := startService(t, config)
	useRegistry(t, config, heldRegistry(t, "0.2.0", "0.3.0"))
	before := readText(t, filepath.Join(config, "plugins/installed.json"))
	code, stdout, stderr := run("plugin", "update", "probe", "--config-dir", config)
	want := "sok: plugin probe 0.3.0: sidecar " + heldSidecar + " 0.2.0 waits for the end of its running service unknown\n"
	if code != 1 || stdout != "" || stderr != want {
		t.Fatalf("the update beside the running service: code %d stdout %q stderr %q, want %q", code, stdout, stderr, want)
	}
	if after := readText(t, filepath.Join(config, "plugins/installed.json")); after != before {
		t.Fatalf("installed.json changed to %s", after)
	}
	if exists(filepath.Join(config, "plugins/probe/0.3.0")) || exists(filepath.Join(config, "sidecars/scope-sidecar-worker/0.2.0")) {
		t.Fatal("the held update extracted a release")
	}
	// The endpoint names no process after the end of the service, so the update runs.
	end()
	if text := succeeds(t, "plugin", "update", "probe", "--config-dir", config); !strings.Contains(text, `"version": "0.3.0"`) {
		t.Fatalf("the update after the end of the service printed %s", text)
	}
}

// contract: cli.plugin.update-waits-for-a-running-service
func TestAnOperationOfTheHostEndsTheHoldingServiceBeforeItWritesTheState(t *testing.T) {
	config := t.TempDir()
	useRegistry(t, config, heldRegistry(t, "0.2.0"))
	succeeds(t, "plugin", "install", "probe", "--config-dir", config)
	useRegistry(t, config, heldRegistry(t, "0.2.0", "0.3.0"))
	running := "0.1.0"
	platform := mustPlatform(t)
	held := sok.Running{Services: sok.Services{heldSidecar: &running}}
	if _, err := sok.RunPluginAction(config, "update", "probe", "0.0.2", platform, held); err == nil ||
		err.Error() != "plugin probe 0.3.0: sidecar "+heldSidecar+" 0.2.0 waits for the end of its running service 0.1.0" {
		t.Fatalf("the update of the host beside service 0.1.0 returned %v", err)
	}
	// End sees the extracted releases and the earlier installed.json, so a failed end writes nothing.
	var ended [][]string
	held.End = func(sidecars []string) error {
		state := installedOf(t, config)
		if state.Plugins["probe"].Version != "0.2.0" || !exists(filepath.Join(config, "plugins/probe/0.3.0")) ||
			!exists(filepath.Join(config, "sidecars/scope-sidecar-worker/0.2.0")) {
			t.Errorf("at the end of the service installed.json records %+v", state)
		}
		ended = append(ended, sidecars)
		return nil
	}
	if _, err := sok.RunPluginAction(config, "update", "probe", "0.0.2", platform, held); err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(ended, [][]string{{heldSidecar}}) {
		t.Fatalf("the update ended the services %v", ended)
	}
	if version := installedOf(t, config).Sidecars[heldSidecar].Version; version != "0.2.0" {
		t.Fatalf("installed.json records sidecar %s", version)
	}
}

// contract: cli.plugin.update-waits-for-a-running-service
func TestAnEnableBesideAServiceOfAnotherVersionIsHeld(t *testing.T) {
	config := t.TempDir()
	useRegistry(t, config, heldRegistry(t, "0.2.0"))
	succeeds(t, "plugin", "install", "probe", "--config-dir", config)
	succeeds(t, "plugin", "disable", "probe", "--config-dir", config)
	before := readText(t, filepath.Join(config, "plugins/installed.json"))
	running := "0.0.9"
	held := sok.Running{Services: sok.Services{heldSidecar: &running}}
	_, err := sok.RunPluginAction(config, "enable", "probe", "0.0.2", mustPlatform(t), held)
	if want := "plugin probe 0.2.0: sidecar " + heldSidecar + " 0.1.0 waits for the end of its running service 0.0.9"; err == nil || err.Error() != want {
		t.Fatalf("the enable beside service 0.0.9 returned %v, want %q", err, want)
	}
	if after := readText(t, filepath.Join(config, "plugins/installed.json")); after != before {
		t.Fatalf("installed.json changed to %s", after)
	}
	// A service of the recorded version does not hold the enable.
	running = "0.1.0"
	if _, err := sok.RunPluginAction(config, "enable", "probe", "0.0.2", mustPlatform(t), held); err != nil {
		t.Fatal(err)
	}
	var state sok.InstalledState
	if err := json.Unmarshal([]byte(readText(t, filepath.Join(config, "plugins/installed.json"))), &state); err != nil || !state.Plugins["probe"].Enabled {
		t.Fatalf("the enable beside service 0.1.0 left %+v, %v", state.Plugins["probe"], err)
	}
}
