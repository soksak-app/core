// The host gives the writer the classes that the catalogs of the enabled installed plugins declare, and records a catalog that
// it cannot use as an error that names the file (docs/spec/logging.md#plugin-catalogs).
package host_test

import (
	"os"
	"path/filepath"
	"testing"
	"time"

	host "github.com/soksak-app/core/packages/host/wailsv3/src"
)

func writeCatalogPlugin(t *testing.T, config, id, catalog string) string {
	t.Helper()
	folder := filepath.Join(config, "plugins", id, "1.0.0")
	if err := os.MkdirAll(folder, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(folder, "plugin.json"), []byte(`{"id":"`+id+`","events":"events.json"}`), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(folder, "events.json"), []byte(catalog), 0o644); err != nil {
		t.Fatal(err)
	}
	return filepath.Join(folder, "events.json")
}

// contract: log.plugin-catalog.host-applies-the-installed-catalogs
func TestTheHostClassifiesPluginEventsByTheInstalledCatalogsAndRecordsACatalogItCannotUse(t *testing.T) {
	log := useEventLog(t)
	config := t.TempDir()
	writeCatalogPlugin(t, config, "probe", `{"schema":3,"events":{"plugin.probe.frame":{"layer":"plugin","class":"frame","level":"debug","fields":{"$schema":"https://json-schema.org/draft/2020-12/schema","type":"object","properties":{"sequence":{"type":"number"}},"required":["sequence"]}}}}`)
	broken := writeCatalogPlugin(t, config, "broken", `{"events":`)
	installed := `{"format":3,"plugins":{` +
		`"probe":{"version":"1.0.0","path":"plugins/probe/1.0.0","enabled":true,"sidecars":{}},` +
		`"broken":{"version":"1.0.0","path":"plugins/broken/1.0.0","enabled":true,"sidecars":{}}},"sidecars":{}}`
	if err := os.WriteFile(filepath.Join(config, "plugins", "installed.json"), []byte(installed), 0o644); err != nil {
		t.Fatal(err)
	}
	host.ApplyPluginEventClasses(log, config)
	log.Emit(host.LevelInfo, "plugin.probe.frame", map[string]any{"sequence": 1})
	if err := log.Flush(5 * time.Second); err != nil {
		t.Fatal(err)
	}
	events := readEventLog(t, log.Path())
	var record, frame map[string]any
	for _, event := range events {
		switch event["event"] {
		case "host.record.error":
			record = event
		case "plugin.probe.frame":
			frame = event
		}
	}
	if frame == nil || frame["class"] != "frame" || frame["undeclared"] != nil {
		t.Fatalf("the plugin event is %v; events %v", frame, events)
	}
	want := broken + ": the event catalog of plugin broken is not JSON"
	if record == nil || record["fields"].(map[string]any)["where"] != "plugin catalog" || record["fields"].(map[string]any)["text"] != want {
		t.Fatalf("the record is %v, want the error %q of plugin catalog", record, want)
	}
}

// contract: log.plugin-catalog.keeps-the-catalogs-of-earlier-plugins
func TestTheHostKeepsTheClassesOfAPluginThatAChangeRemoved(t *testing.T) {
	log := useEventLog(t)
	config := t.TempDir()
	writeCatalogPlugin(t, config, "probe", `{"schema":3,"events":{"plugin.probe.frame":{"layer":"plugin","class":"frame","level":"debug","fields":{"$schema":"https://json-schema.org/draft/2020-12/schema","type":"object","properties":{"sequence":{"type":"number"}},"required":["sequence"]}}}}`)
	installed := filepath.Join(config, "plugins", "installed.json")
	if err := os.WriteFile(installed, []byte(`{"format":3,"plugins":{"probe":{"version":"1.0.0","path":"plugins/probe/1.0.0","enabled":true,"sidecars":{}}},"sidecars":{}}`), 0o644); err != nil {
		t.Fatal(err)
	}
	host.ApplyPluginEventClasses(log, config)
	// The change removes the plugin; a page that loaded it before the change still runs its code until it reloads.
	if err := os.WriteFile(installed, []byte(`{"format":3,"plugins":{},"sidecars":{}}`), 0o644); err != nil {
		t.Fatal(err)
	}
	host.ApplyPluginEventClasses(log, config)
	log.Emit(host.LevelInfo, "plugin.probe.frame", map[string]any{"sequence": 1})
	if err := log.Flush(5 * time.Second); err != nil {
		t.Fatal(err)
	}
	var frame map[string]any
	for _, event := range readEventLog(t, log.Path()) {
		if event["event"] == "plugin.probe.frame" {
			frame = event
		}
	}
	if frame == nil || frame["class"] != "frame" || frame["undeclared"] != nil {
		t.Fatalf("the event of the removed plugin is %v, want the class frame of its catalog", frame)
	}
}

// contract: log.plugin-catalog.records-the-held-catalogs
func TestTheWriterRecordsThePluginCatalogsItHoldsAtEachApply(t *testing.T) {
	log := useEventLog(t)
	config := t.TempDir()
	writeCatalogPlugin(t, config, "probe", `{"schema":3,"events":{"plugin.probe.frame":{"layer":"plugin","class":"frame","level":"debug","fields":{"$schema":"https://json-schema.org/draft/2020-12/schema","type":"object","properties":{"sequence":{"type":"number"}},"required":["sequence"]}}}}`)
	writeCatalogPlugin(t, config, "broken", `{"events":`)
	installed := func(probeEnabled string) string {
		return `{"format":3,"plugins":{` +
			`"probe":{"version":"1.0.0","path":"plugins/probe/1.0.0","enabled":` + probeEnabled + `,"sidecars":{}},` +
			`"broken":{"version":"1.0.0","path":"plugins/broken/1.0.0","enabled":true,"sidecars":{}}},"sidecars":{}}`
	}
	if err := os.WriteFile(filepath.Join(config, "plugins", "installed.json"), []byte(installed("true")), 0o644); err != nil {
		t.Fatal(err)
	}
	host.ApplyPluginEventClasses(log, config)
	if err := os.WriteFile(filepath.Join(config, "plugins", "installed.json"), []byte(installed("false")), 0o644); err != nil {
		t.Fatal(err)
	}
	host.ApplyPluginEventClasses(log, config)
	if err := log.Flush(5 * time.Second); err != nil {
		t.Fatal(err)
	}
	var applies []map[string]any
	for _, event := range readEventLog(t, log.Path()) {
		if event["event"] == "log.plugins" {
			applies = append(applies, event)
		}
	}
	if len(applies) != 2 {
		t.Fatalf("%d log.plugins records, want one per apply: %v", len(applies), applies)
	}
	// default: the writer keeps the catalog of a plugin that a change disabled, and a catalog it cannot use is not held.
	for i, record := range applies {
		plugins, _ := record["fields"].(map[string]any)["plugins"].([]any)
		if len(plugins) != 1 || plugins[0].(map[string]any)["plugin"] != "probe" || plugins[0].(map[string]any)["version"] != "1.0.0" {
			t.Fatalf("apply %d names %v, want [{probe 1.0.0}]", i+1, plugins)
		}
	}
}
