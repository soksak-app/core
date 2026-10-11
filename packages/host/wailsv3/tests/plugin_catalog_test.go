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
	writeCatalogPlugin(t, config, "probe", `{"events":{"plugin.probe.frame":{"class":"frame"}}}`)
	broken := writeCatalogPlugin(t, config, "broken", `{"events":`)
	installed := `{"format":2,"plugins":{` +
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
