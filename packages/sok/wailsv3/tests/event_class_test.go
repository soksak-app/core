package tests

// Checks the class of the lines of the event file of the tool and the class table of the catalog
// (docs/spec/logging.md#event, docs/spec/logging.md#classes-and-policy).

import (
	"testing"

	"github.com/soksak-app/core/packages/sok/wailsv3/src"
)

// contract: cli.log.stores-class
func TestEveryLineOfTheToolStoresTheClassOfItsCatalogEntry(t *testing.T) {
	lines := writeEvents(t, func(log *sok.EventLog) {
		log.Emit(sok.LevelWarn, "sok.command", map[string]any{"name": "x"})
		log.Emit(sok.LevelError, "sok.panic", map[string]any{"name": "main", "text": "t", "stack": "s"})
		log.Emit(sok.LevelInfo, "sok.surprise", map[string]any{})
	})
	want := []struct {
		event, class string
		undeclared   bool
	}{{"log.open", "lifecycle", false}, {"log.policy", "lifecycle", false}, {"sok.command", "call", false}, {"sok.panic", "lifecycle", false}, {"sok.surprise", "", true}}
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

// contract: cli.log.stores-class
func TestTheClassTableGivesTheCatalogClassOfEventsAndFamilies(t *testing.T) {
	for name, want := range map[string]sok.Class{
		"log.open": sok.ClassLifecycle, "host.binding.call": sok.ClassCall, "host.input.relay": sok.ClassInput, "host.sidecar.request": sok.ClassIo,
		"native.observe.counted": sok.ClassFrame, "page.console.warn": sok.ClassLifecycle, "host.trace.mark": sok.ClassCall,
		"host.trace.view.presentation-join": sok.ClassCall,
	} {
		if got, declared := sok.EventClassOf(name); !declared || got != want {
			t.Fatalf("%s: %q declared %v, want %q", name, got, declared, want)
		}
	}
	for _, name := range []string{"host.nothing", "page.console.", "page.console.WARN", "plugin.editor.opened", ""} {
		if got, declared := sok.EventClassOf(name); declared {
			t.Fatalf("%q is declared with the class %q", name, got)
		}
	}
}
