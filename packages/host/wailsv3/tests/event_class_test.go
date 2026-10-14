// The class of an event line (docs/spec/logging.md#event): the writer stores the class that the catalog declares for the
// event name, and marks an event the catalog does not declare.
package host_test

import (
	"slices"
	"testing"
	"time"

	host "github.com/soksak-app/core/packages/host/wailsv3/src"
)

// contract: log.writer.stores-class
func TestEveryLineStoresTheClassOfItsCatalogEntry(t *testing.T) {
	log, err := host.StartEventLog(eventLogOptions(t.TempDir()))
	if err != nil {
		t.Fatal(err)
	}
	if !log.Emit(host.LevelInfo, "host.app.event", map[string]any{"kind": "started"}) {
		t.Fatal("host.app.event was refused")
	}
	if !log.EmitCids(host.LevelInfo, "host.input.relay", []string{"b1.1"}, map[string]any{"surface": "s", "name": "n", "type": "t"}) {
		t.Fatal("host.input.relay was refused")
	}
	if !log.Emit(host.LevelInfo, "host.sidecar.reply", map[string]any{"name": "n", "surface": "s", "bytes": 1, "ok": true}) {
		t.Fatal("host.sidecar.reply was refused")
	}
	relayed := host.RelayedEvent{TsMicros: 1, MonoNs: 1, Layer: "page", Page: "1791948729050", Level: host.LevelInfo, Event: "page.start", Fields: []byte(`{"time_origin":1,"url":"u"}`)}
	if accepted, err := log.EmitRelayed(relayed); err != nil || !accepted {
		t.Fatalf("page.start: %v %v", accepted, err)
	}
	family := host.RelayedEvent{TsMicros: 1, MonoNs: 1, Layer: "page", Page: "1791948729050", Level: host.LevelInfo, Event: "page.console.info", Fields: []byte(`{"text":"x"}`)}
	if accepted, err := log.EmitRelayed(family); err != nil || !accepted {
		t.Fatalf("page.console.info: %v %v", accepted, err)
	}
	if err := log.Flush(5 * time.Second); err != nil {
		t.Fatal(err)
	}
	want := map[string]string{
		"log.open": "lifecycle", "host.app.event": "lifecycle", "host.input.relay": "input", "host.sidecar.reply": "io",
		"page.start": "lifecycle", "page.console.info": "lifecycle",
	}
	seen := 0
	for _, event := range readEventLog(t, log.Path()) {
		name := event["event"].(string)
		class, ok := want[name]
		if !ok {
			continue
		}
		seen++
		if event["class"] != class {
			t.Fatalf("%s has class %v, want %s: %v", name, event["class"], class, event)
		}
		if _, marked := event["undeclared"]; marked {
			t.Fatalf("%s is declared but marked undeclared: %v", name, event)
		}
	}
	if seen != len(want) {
		t.Fatalf("saw %d of %d declared events", seen, len(want))
	}
}

// contract: log.writer.marks-undeclared
func TestAnEventTheCatalogDoesNotDeclareIsMarkedUndeclaredAndHasNoClass(t *testing.T) {
	log, err := host.StartEventLog(eventLogOptions(t.TempDir()))
	if err != nil {
		t.Fatal(err)
	}
	if !log.Emit(host.LevelInfo, "host.test.event", map[string]any{"index": 1}) {
		t.Fatal("host.test.event was refused")
	}
	relayed := host.RelayedEvent{TsMicros: 1, MonoNs: 1, Layer: "plugin", Page: "1791948729050", Level: host.LevelInfo, Event: "plugin.editor.opened", Fields: []byte(`{}`)}
	if accepted, err := log.EmitRelayed(relayed); err != nil || !accepted {
		t.Fatalf("plugin.editor.opened: %v %v", accepted, err)
	}
	if err := log.Flush(5 * time.Second); err != nil {
		t.Fatal(err)
	}
	marked := 0
	for _, event := range readEventLog(t, log.Path()) {
		name := event["event"].(string)
		if name != "host.test.event" && name != "plugin.editor.opened" {
			continue
		}
		marked++
		if event["undeclared"] != true {
			t.Fatalf("%s is not marked undeclared: %v", name, event)
		}
		if _, has := event["class"]; has {
			t.Fatalf("%s has a class although the catalog does not declare it: %v", name, event)
		}
	}
	if marked != 2 {
		t.Fatalf("saw %d undeclared events", marked)
	}
}

// contract: log.writer.stores-class
func TestTheEventsOfTheWriterItselfStoreTheirClass(t *testing.T) {
	options := eventLogOptions(t.TempDir())
	options.RotateBytes = 600
	options.QueueEvents = 4
	options.BatchInterval = 30 * time.Second
	log, err := host.StartEventLog(options)
	if err != nil {
		t.Fatal(err)
	}
	for index := 0; index < 40; index++ {
		log.Emit(host.LevelInfo, "host.app.event", map[string]any{"kind": "started"})
	}
	if err := log.Flush(5 * time.Second); err != nil {
		t.Fatal(err)
	}
	var names []string
	for _, name := range []string{log.Path() + ".1", log.Path() + ".2", log.Path() + ".3", log.Path()} {
		for _, event := range readEventLog(t, name) {
			switch event["event"] {
			case "log.open", "log.rotated", "log.dropped":
				names = append(names, event["event"].(string))
				if event["class"] != "lifecycle" {
					t.Fatalf("%v has class %v, want lifecycle", event["event"], event["class"])
				}
			}
		}
	}
	for _, want := range []string{"log.rotated", "log.dropped"} {
		if !slices.Contains(names, want) {
			t.Fatalf("the test produced no %s: %v", want, names)
		}
	}
}
