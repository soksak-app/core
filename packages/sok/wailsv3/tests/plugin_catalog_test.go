package tests

// Checks that the writer gives a plugin event the class that the catalog of its plugin declares, and that the catalogs are
// read from the enabled installed plugins (docs/spec/logging.md#plugin-catalogs).

import (
	"os"
	"path/filepath"
	"reflect"
	"testing"

	"github.com/soksak-app/core/packages/sok/wailsv3/src"
)

// contract: log.plugin-catalog.classifies-plugin-events
func TestAPluginEventHasTheClassThatTheCatalogOfItsPluginDeclares(t *testing.T) {
	lines := writeEvents(t, func(log *sok.EventLog) {
		log.SetPluginClasses(map[string]sok.Class{"plugin.probe.frame": sok.ClassFrame})
		log.Emit(sok.LevelInfo, "plugin.probe.frame", map[string]any{"sequence": 1})
		log.Emit(sok.LevelInfo, "plugin.probe.other", map[string]any{})
	})
	want := []struct {
		event, class string
		undeclared   bool
	}{{"log.open", "lifecycle", false}, {"plugin.probe.frame", "frame", false}, {"plugin.probe.other", "", true}}
	if len(lines) != len(want) {
		t.Fatalf("%d lines: %v", len(lines), lines)
	}
	for index, line := range lines {
		event := decodeEvent(t, line)
		if event.Event != want[index].event || event.Class != want[index].class || event.Undeclared != want[index].undeclared {
			t.Fatalf("line %d is %+v, want %+v", index+1, event, want[index])
		}
	}
}

// writePlugin writes an installed plugin of the configuration folder with its plugin.json and, when catalog is not empty, the
// catalog file events.json that the manifest names.
func writePlugin(t *testing.T, config, id, catalog string) {
	t.Helper()
	folder := filepath.Join(config, "plugins", id, "1.0.0")
	if err := os.MkdirAll(folder, 0o755); err != nil {
		t.Fatal(err)
	}
	manifest := `{"id":"` + id + `","events":"events.json"}`
	if err := os.WriteFile(filepath.Join(folder, "plugin.json"), []byte(manifest), 0o644); err != nil {
		t.Fatal(err)
	}
	if catalog != "" {
		if err := os.WriteFile(filepath.Join(folder, "events.json"), []byte(catalog), 0o644); err != nil {
			t.Fatal(err)
		}
	}
}

func writeInstalled(t *testing.T, config, plugins string) {
	t.Helper()
	if err := os.WriteFile(filepath.Join(config, "plugins", "installed.json"), []byte(`{"format":2,"plugins":{`+plugins+`},"sidecars":{}}`), 0o644); err != nil {
		t.Fatal(err)
	}
}

// contract: log.plugin-catalog.reads-the-enabled-plugins
func TestThePluginClassesAreTheCatalogsOfTheEnabledInstalledPlugins(t *testing.T) {
	config := t.TempDir()
	writePlugin(t, config, "probe", `{"events":{"plugin.probe.frame":{"layer":"plugin","class":"frame","level":"debug","fields":{}},"plugin.probe.error":{"layer":"plugin","class":"lifecycle","level":"error","fields":{}}}}`)
	writePlugin(t, config, "fixture", `{"events":{"plugin.fixture.watch":{"layer":"plugin","class":"io","level":"debug","fields":{}}}}`)
	writeInstalled(t, config, `"probe":{"version":"1.0.0","path":"plugins/probe/1.0.0","enabled":true,"sidecars":{}},"fixture":{"version":"1.0.0","path":"plugins/fixture/1.0.0","enabled":false,"sidecars":{}}`)
	classes, errs := sok.PluginEventClasses(config)
	if len(errs) != 0 {
		t.Fatalf("errors %v", errs)
	}
	want := map[string]sok.Class{"plugin.probe.frame": sok.ClassFrame, "plugin.probe.error": sok.ClassLifecycle}
	if !reflect.DeepEqual(classes, want) {
		t.Fatalf("classes %v, want %v", classes, want)
	}
}

// contract: log.plugin-catalog.refuses-a-catalog
func TestACatalogThatCannotBeUsedIsAnErrorThatNamesItsFileAndTheOtherPluginsKeepTheirClasses(t *testing.T) {
	config := t.TempDir()
	writePlugin(t, config, "probe", `{"events":{"plugin.probe.frame":{"class":"frame"}}}`)
	writePlugin(t, config, "outside", `{"events":{"plugin.probe.frame":{"class":"frame"}}}`)
	writePlugin(t, config, "classless", `{"events":{"plugin.classless.x":{"class":"often"}}}`)
	writePlugin(t, config, "broken", `{"events":`)
	writePlugin(t, config, "missing", "")
	enabled := func(id string) string {
		return `"` + id + `":{"version":"1.0.0","path":"plugins/` + id + `/1.0.0","enabled":true,"sidecars":{}}`
	}
	writeInstalled(t, config, enabled("probe")+","+enabled("outside")+","+enabled("classless")+","+enabled("broken")+","+enabled("missing"))
	classes, errs := sok.PluginEventClasses(config)
	if !reflect.DeepEqual(classes, map[string]sok.Class{"plugin.probe.frame": sok.ClassFrame}) {
		t.Fatalf("classes %v", classes)
	}
	file := func(id string) string { return filepath.Join(config, "plugins", id, "1.0.0", "events.json") }
	want := []string{
		file("broken") + ": the event catalog of plugin broken is not JSON",
		file("classless") + ": the event plugin.classless.x has the class often, which is not lifecycle, input, call, io or frame",
		file("missing") + ": the event catalog of plugin missing does not exist",
		file("outside") + ": the event plugin.probe.frame is not an event of plugin outside (plugin.outside.<event>)",
	}
	var got []string
	for _, err := range errs {
		got = append(got, err.Error())
	}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("errors\n%q\nwant\n%q", got, want)
	}
}
