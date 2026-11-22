package host_test

// Checks the update of installed plugins at start (docs/spec/installation.md#update-at-start). The registries are real index files
// with real releases, read through the file: location that the registry contract accepts.

import (
	"archive/tar"
	"bytes"
	"compress/gzip"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"

	host "github.com/soksak-app/core/packages/host/go/src"
	"github.com/soksak-app/core/packages/host/go/tests/support"
	sok "github.com/soksak-app/core/packages/sok/go/src"
)

// startRelease is one version of the probe plugin in a registry: its engines range and its plugin.json text.
type startRelease struct {
	version, engines, manifest string
}

// validManifest is the plugin.json of the probe fixture, which the reader accepts.
func validManifest(t *testing.T) string {
	t.Helper()
	data, err := os.ReadFile(filepath.Join("fixtures", "plugin-probe", "plugin.json"))
	if err != nil {
		t.Fatal(err)
	}
	return string(data)
}

// refusedManifest is the plugin.json that the reader refuses: its top-level member host is not a member of the current contract.
func refusedManifest(t *testing.T) string {
	t.Helper()
	return strings.Replace(validManifest(t), `"description": "Sample.",`, `"description": "Sample.", "host": {},`, 1)
}

// packStartRelease writes the release of one version in the layout that `npm pack` writes and returns its sha256.
func packStartRelease(t *testing.T, path string, release startRelease) string {
	t.Helper()
	files := map[string]string{
		"package.json": fmt.Sprintf(`{"name": "plugin-probe", "version": %q, "engines": {"soksak": %q}, "files": ["plugin.json"]}`,
			release.version, release.engines),
		"plugin.json": release.manifest,
	}
	var data bytes.Buffer
	zipped := gzip.NewWriter(&data)
	stream := tar.NewWriter(zipped)
	for _, name := range []string{"package.json", "plugin.json"} {
		content := []byte(files[name])
		if err := stream.WriteHeader(&tar.Header{Typeflag: tar.TypeReg, Name: "package/" + name, Mode: 0o644, Size: int64(len(content))}); err != nil {
			t.Fatal(err)
		}
		if _, err := stream.Write(content); err != nil {
			t.Fatal(err)
		}
	}
	if err := stream.Close(); err != nil {
		t.Fatal(err)
	}
	if err := zipped.Close(); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, data.Bytes(), 0o644); err != nil {
		t.Fatal(err)
	}
	sum := sha256.Sum256(data.Bytes())
	return hex.EncodeToString(sum[:])
}

// writeStartRegistry packs the releases into dir, builds the registry index dir/index.json of them and returns its path.
// Calling it again on the same dir replaces the releases and the index.
func writeStartRegistry(t *testing.T, dir string, releases ...startRelease) string {
	t.Helper()
	if err := os.MkdirAll(filepath.Join(dir, "releases"), 0o755); err != nil {
		t.Fatal(err)
	}
	var versions []string
	for _, release := range releases {
		path := filepath.Join(dir, "releases", "plugin-probe-"+release.version+".tgz")
		sum := packStartRelease(t, path, release)
		versions = append(versions, fmt.Sprintf(`{"version": %q, "release": {"url": "file://%s", "sha256": %q}, "engines": {"soksak": %q}, "sidecars": {}}`,
			release.version, path, sum, release.engines))
	}
	support.WriteInstalled(t, dir, map[string]string{
		"plugins/probe.json": `{"id": "probe", "package": "plugin-probe", "name": "Probe", "description": "검사용 plugin.",
			"license": "MIT", "repository": "https://example.invalid/probe", "versions": [` + strings.Join(versions, ",") + `]}`,
		"revoked.json": `{"plugins": [], "sidecars": []}`,
	})
	var stdout, stderr bytes.Buffer
	if code := sok.Run([]string{"registry", "build", dir}, &stdout, &stderr, sok.Options{Identifier: "com.soksak.test", CoreVersion: sok.CoreVersion}); code != 0 {
		t.Fatalf("registry build: code %d stderr %s", code, stderr.String())
	}
	return filepath.Join(dir, "index.json")
}

// installedProbe returns the installed version of the probe plugin and the text of plugins/installed.json.
func installedProbe(t *testing.T, config string) (string, string) {
	t.Helper()
	state, err := sok.ReadInstalled(config)
	if err != nil {
		t.Fatal(err)
	}
	data, err := os.ReadFile(filepath.Join(config, "plugins", "installed.json"))
	if err != nil {
		t.Fatal(err)
	}
	return state.Plugins["probe"].Version, string(data)
}

// refuseInstalledManifest replaces the plugin.json of the installed probe version with the refused manifest, which is what an
// earlier release of the application left in the configuration folder.
func refuseInstalledManifest(t *testing.T, config, version string) {
	t.Helper()
	if err := os.WriteFile(filepath.Join(config, "plugins", "probe", version, "plugin.json"), []byte(refusedManifest(t)), 0o644); err != nil {
		t.Fatal(err)
	}
}

// installProbe installs the newest accepted version of the probe plugin from the registry of config.
func installProbe(t *testing.T, plugins *host.Plugins, config, index string) {
	t.Helper()
	if _, err := sok.UseRegistry(config, index, sok.DefaultFetcher); err != nil {
		t.Fatal(err)
	}
	if _, err := plugins.Run(host.PluginsRunRequest{Action: "install", Plugin: "probe"}); err != nil {
		t.Fatal(err)
	}
}

// contract: plugins.start-update.replaces-refused-with-newest-accepted
func TestStartUpdateReplacesARefusedInstalledPluginWithTheNewestAcceptedVersion(t *testing.T) {
	config, registry := t.TempDir(), t.TempDir()
	plugins, changes := support.NewPlugins(t, config)
	index := writeStartRegistry(t, registry, startRelease{"0.0.1", ">=0.0.1 <1.0.0", validManifest(t)})
	installProbe(t, plugins, config, index)
	refuseInstalledManifest(t, config, "0.0.1")
	index = writeStartRegistry(t, registry,
		startRelease{"0.0.1", ">=0.0.1 <1.0.0", validManifest(t)},
		startRelease{"0.0.2", ">=0.0.1 <1.0.0", validManifest(t)},
		startRelease{"0.0.3", ">=0.0.1 <0.0.46", validManifest(t)})
	setup := len(changes.List())

	results := plugins.UpdateAtStart()
	if len(results) != 1 || results[0].Plugin != "probe" || results[0].From != "0.0.1" || results[0].To != "0.0.2" || results[0].Err != nil {
		t.Fatalf("start update results %+v", results)
	}
	if version, _ := installedProbe(t, config); version != "0.0.2" {
		t.Fatalf("installed version %s, want 0.0.2: the version 0.0.3 is not accepted by core %s", version, sok.CoreVersion)
	}
	if list := changes.List()[setup:]; len(list) != 1 || list[0] != (host.PluginsChanged{Action: "update", Plugin: "probe"}) {
		t.Fatalf("changes %+v", list)
	}
}

// contract: plugins.start-update.advances-older-accepted
func TestStartUpdateAdvancesAnOlderInstalledPluginToTheNewestAcceptedVersion(t *testing.T) {
	config, registry := t.TempDir(), t.TempDir()
	plugins, _ := support.NewPlugins(t, config)
	index := writeStartRegistry(t, registry, startRelease{"0.0.1", ">=0.0.1 <1.0.0", validManifest(t)})
	installProbe(t, plugins, config, index)
	index = writeStartRegistry(t, registry,
		startRelease{"0.0.1", ">=0.0.1 <1.0.0", validManifest(t)},
		startRelease{"0.0.2", ">=0.0.1 <1.0.0", validManifest(t)})

	results := plugins.UpdateAtStart()
	if len(results) != 1 || results[0].Plugin != "probe" || results[0].From != "0.0.1" || results[0].To != "0.0.2" || results[0].Err != nil {
		t.Fatalf("start update results %+v", results)
	}
	if version, _ := installedProbe(t, config); version != "0.0.2" {
		t.Fatalf("installed version %s, want 0.0.2", version)
	}
}

// contract: plugins.start-update.repeated-start-changes-nothing
func TestRepeatedStartUpdateChangesNothing(t *testing.T) {
	config, registry := t.TempDir(), t.TempDir()
	plugins, changes := support.NewPlugins(t, config)
	index := writeStartRegistry(t, registry, startRelease{"0.0.1", ">=0.0.1 <1.0.0", validManifest(t)})
	installProbe(t, plugins, config, index)
	refuseInstalledManifest(t, config, "0.0.1")
	index = writeStartRegistry(t, registry,
		startRelease{"0.0.1", ">=0.0.1 <1.0.0", validManifest(t)},
		startRelease{"0.0.2", ">=0.0.1 <1.0.0", validManifest(t)})
	if results := plugins.UpdateAtStart(); len(results) != 1 || results[0].Err != nil {
		t.Fatalf("first start %+v", results)
	}
	_, before := installedProbe(t, config)
	count := len(changes.List())

	if results := plugins.UpdateAtStart(); len(results) != 0 {
		t.Fatalf("repeated start results %+v", results)
	}
	if _, after := installedProbe(t, config); after != before {
		t.Fatalf("repeated start changed plugins/installed.json:\n%s\nafter:\n%s", before, after)
	}
	if len(changes.List()) != count {
		t.Fatalf("repeated start sent changes %+v", changes.List())
	}
}

// contract: plugins.start-update.refused-without-newer-is-reported-and-kept
func TestStartUpdateReportsARefusedPluginWithoutANewerAcceptedVersionAndKeepsIt(t *testing.T) {
	config, registry := t.TempDir(), t.TempDir()
	plugins, changes := support.NewPlugins(t, config)
	index := writeStartRegistry(t, registry, startRelease{"0.0.1", ">=0.0.1 <1.0.0", validManifest(t)})
	installProbe(t, plugins, config, index)
	refuseInstalledManifest(t, config, "0.0.1")
	_, before := installedProbe(t, config)
	setup := len(changes.List())

	results := plugins.UpdateAtStart()
	if len(results) != 1 || results[0].Plugin != "probe" || results[0].Err == nil || !strings.Contains(results[0].Err.Error(), "host") {
		t.Fatalf("start update results %+v", results)
	}
	if _, after := installedProbe(t, config); after != before {
		t.Fatalf("a refused plugin without a newer release changed plugins/installed.json")
	}
	if list := changes.List()[setup:]; len(list) != 0 {
		t.Fatalf("changes %+v", list)
	}
}

// contract: plugins.start-update.unreadable-registry-is-reported
func TestStartUpdateReportsAnUnreadableRegistryAndChangesNothing(t *testing.T) {
	config, registry := t.TempDir(), t.TempDir()
	plugins, _ := support.NewPlugins(t, config)
	index := writeStartRegistry(t, registry, startRelease{"0.0.1", ">=0.0.1 <1.0.0", validManifest(t)})
	installProbe(t, plugins, config, index)
	_, before := installedProbe(t, config)
	// The registry is set to an https address that refuses the connection, as an offline machine would.
	support.WriteInstalled(t, config, map[string]string{
		"plugins/registry.json": `{"format": 1, "index": "https://127.0.0.1:1/index.json"}`,
	})

	results := plugins.UpdateAtStart()
	if len(results) != 1 || results[0].Plugin != "" || results[0].Err == nil || !strings.Contains(results[0].Err.Error(), "127.0.0.1:1") {
		t.Fatalf("start update results %+v", results)
	}
	if _, after := installedProbe(t, config); after != before {
		t.Fatalf("an unreadable registry changed plugins/installed.json")
	}
}

// contract: plugins.start-update.failure-is-kept-in-plugins-state
func TestStartUpdateFailureIsKeptInThePluginsState(t *testing.T) {
	config, registry := t.TempDir(), t.TempDir()
	plugins, _ := support.NewPlugins(t, config)
	index := writeStartRegistry(t, registry, startRelease{"0.0.1", ">=0.0.1 <1.0.0", validManifest(t)})
	installProbe(t, plugins, config, index)
	refuseInstalledManifest(t, config, "0.0.1")

	if results := plugins.UpdateAtStart(); len(results) != 1 || results[0].Err == nil {
		t.Fatalf("start update results %+v", results)
	}
	state, err := plugins.State()
	if err != nil {
		t.Fatal(err)
	}
	if len(state.StartUpdate) != 1 || state.StartUpdate[0].Where != "plugin update probe" || !strings.Contains(state.StartUpdate[0].Text, "host") {
		t.Fatalf("start update failures in the plugins state: %+v", state.StartUpdate)
	}
}

// contract: plugins.start-update.shutdown-before-start-changes-nothing
func TestAShutdownBeforeTheStartUpdateChangesNothing(t *testing.T) {
	config, registry := t.TempDir(), t.TempDir()
	plugins, changes := support.NewPlugins(t, config)
	index := writeStartRegistry(t, registry, startRelease{"0.0.1", ">=0.0.1 <1.0.0", validManifest(t)})
	installProbe(t, plugins, config, index)
	refuseInstalledManifest(t, config, "0.0.1")
	index = writeStartRegistry(t, registry,
		startRelease{"0.0.1", ">=0.0.1 <1.0.0", validManifest(t)},
		startRelease{"0.0.2", ">=0.0.1 <1.0.0", validManifest(t)})
	_, before := installedProbe(t, config)
	setup := len(changes.List())

	plugins.Stop()
	results := plugins.UpdateAtStart()
	if len(results) != 1 || results[0].Err == nil || !strings.Contains(results[0].Err.Error(), "shutting down") {
		t.Fatalf("start update results after the shutdown began %+v", results)
	}
	if _, after := installedProbe(t, config); after != before {
		t.Fatalf("a start update after the shutdown began changed plugins/installed.json")
	}
	if _, err := os.Stat(filepath.Join(config, "plugins", "probe", "0.0.2")); !os.IsNotExist(err) {
		t.Fatalf("a start update after the shutdown began extracted the release: %v", err)
	}
	if list := changes.List()[setup:]; len(list) != 0 {
		t.Fatalf("changes %+v", list)
	}
}

// contract: plugins.start-update.shutdown-during-install-applies-nothing
func TestAShutdownDuringTheInstallLeavesThePreviousInstallation(t *testing.T) {
	config, registry := t.TempDir(), t.TempDir()
	plugins, _ := support.NewPlugins(t, config)
	index := writeStartRegistry(t, registry, startRelease{"0.0.1", ">=0.0.1 <1.0.0", validManifest(t)})
	installProbe(t, plugins, config, index)
	index = writeStartRegistry(t, registry,
		startRelease{"0.0.1", ">=0.0.1 <1.0.0", validManifest(t)},
		startRelease{"0.0.2", ">=0.0.1 <1.0.0", validManifest(t)})
	_, before := installedProbe(t, config)
	// The stop reports the shutdown from its second check on, which is after the release is extracted and before installed.json
	// is written.
	checks := 0
	stop := func() bool { checks++; return checks >= 2 }
	platform, err := sok.CurrentPlatform()
	if err != nil {
		t.Fatal(err)
	}

	if _, err := sok.UpdatePluginUnless(config, "probe", sok.CoreVersion, platform, stop); err == nil || !strings.Contains(err.Error(), "shutting down") {
		t.Fatalf("update during the shutdown: %v", err)
	}
	if _, after := installedProbe(t, config); after != before {
		t.Fatalf("an update that the shutdown stopped changed plugins/installed.json")
	}
}
