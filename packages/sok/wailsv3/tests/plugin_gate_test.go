package tests

// Checks that the writer gates a plugin event by its class, that an undeclared plugin event takes the class lifecycle and is
// gated as it, and that the view end record passes every gate (docs/spec/logging.md#principles, #policy).

import (
	"encoding/json"
	"testing"
	"time"

	"github.com/soksak-app/core/packages/sok/wailsv3/src"
)

func relayPlugin(event string, level sok.Level) sok.RelayedEvent {
	return sok.RelayedEvent{
		TsMicros: 1,
		MonoNs:   1,
		Layer:    "plugin",
		Page:     "page-1",
		Level:    level,
		Event:    event,
		Fields:   json.RawMessage(`{"sequence":1}`),
	}
}

func gatedRecords(events []map[string]any, class string, level string) []map[string]any {
	var gated []map[string]any
	for _, event := range events {
		fields, _ := event["fields"].(map[string]any)
		if event["event"] == "log.gated" && fields["class"] == class && fields["level"] == level {
			gated = append(gated, event)
		}
	}
	return gated
}

// contract: log.plugin-gate.undeclared-takes-lifecycle
func TestAnUndeclaredPluginEventIsStoredWithTheClassLifecycleAndMarkedUndeclared(t *testing.T) {
	lines := writeEvents(t, func(log *sok.EventLog) {
		if ok, err := log.EmitRelayed(relayPlugin("plugin.probe.other", sok.LevelInfo)); err != nil || !ok {
			t.Fatalf("the undeclared plugin event was refused: %v", err)
		}
	})
	for _, line := range lines {
		event := decodeEvent(t, line)
		if event.Event != "plugin.probe.other" {
			continue
		}
		if event.Class != "lifecycle" || !event.Undeclared {
			t.Fatalf("the undeclared plugin event is %+v, want class lifecycle and undeclared", event)
		}
		return
	}
	t.Fatalf("the undeclared plugin event is not stored: %v", lines)
}

// contract: log.plugin-gate.undeclared-takes-lifecycle
func TestAnUndeclaredPluginEventUnderAPolicyThatTurnsLifecycleOffIsRefusedAndCounted(t *testing.T) {
	log, err := sok.StartEventLog(optionsIn(t.TempDir(), "b1"))
	if err != nil {
		t.Fatal(err)
	}
	defer log.Close()
	policy, err := sok.ParseLogPolicy("log-policy.json", []byte(`{"schema":1,"classes":{"lifecycle":"error","input":"error","call":"error","io":"error","frame":"error"}}`))
	if err != nil {
		t.Fatal(err)
	}
	log.SetPolicy(policy, "file")
	if ok, err := log.EmitRelayed(relayPlugin("plugin.probe.other", sok.LevelInfo)); err != nil || ok {
		t.Fatalf("the undeclared plugin event was stored: ok=%v err=%v", ok, err)
	}
	if err := log.Flush(5 * time.Second); err != nil {
		t.Fatal(err)
	}
	events := storedLines(t, log.Path())
	for _, event := range events {
		if event["event"] == "plugin.probe.other" {
			t.Fatalf("a gated plugin event was stored: %v", event)
		}
	}
	if len(gatedRecords(events, "lifecycle", "info")) != 1 {
		t.Fatalf("the refused plugin event is not counted in log.gated: %v", events)
	}
}

// contract: log.plugin-gate.refuses-below-the-class-level
func TestAPluginEventBelowTheLevelOfItsClassIsRefusedByTheWriterAndCounted(t *testing.T) {
	log, err := sok.StartEventLog(optionsIn(t.TempDir(), "b1"))
	if err != nil {
		t.Fatal(err)
	}
	defer log.Close()
	log.SetPluginClasses(map[string]sok.Class{"plugin.probe.frame": sok.ClassFrame})
	policy, err := sok.ParseLogPolicy("log-policy.json", []byte(`{"schema":1,"classes":{"lifecycle":"trace","input":"trace","call":"trace","io":"trace","frame":"error"}}`))
	if err != nil {
		t.Fatal(err)
	}
	log.SetPolicy(policy, "file")
	if ok, err := log.EmitRelayed(relayPlugin("plugin.probe.frame", sok.LevelInfo)); err != nil || ok {
		t.Fatalf("the plugin event below its class level was stored: ok=%v err=%v", ok, err)
	}
	if err := log.Flush(5 * time.Second); err != nil {
		t.Fatal(err)
	}
	events := storedLines(t, log.Path())
	for _, event := range events {
		if event["event"] == "plugin.probe.frame" {
			t.Fatalf("a plugin event below its class level was stored: %v", event)
		}
	}
	if len(gatedRecords(events, "frame", "info")) != 1 {
		t.Fatalf("the refused plugin event is not counted in log.gated: %v", events)
	}
}

// contract: host.view.killed.passes-every-gate
func TestTheViewEndRecordIsStoredUnderAPolicyThatTurnsLifecycleOff(t *testing.T) {
	log, err := sok.StartEventLog(optionsIn(t.TempDir(), "b1"))
	if err != nil {
		t.Fatal(err)
	}
	defer log.Close()
	policy, err := sok.ParseLogPolicy("log-policy.json", []byte(`{"schema":1,"classes":{"lifecycle":"error","input":"error","call":"error","io":"error","frame":"error"}}`))
	if err != nil {
		t.Fatal(err)
	}
	log.SetPolicy(policy, "file")
	if !log.Emit(sok.LevelWarn, "host.view.killed", map[string]any{"plugin": "probe", "surface": "view-1", "unsent": true}) {
		t.Fatal("host.view.killed was refused")
	}
	if err := log.Flush(5 * time.Second); err != nil {
		t.Fatal(err)
	}
	var stored []map[string]any
	for _, event := range storedLines(t, log.Path()) {
		if event["event"] == "host.view.killed" {
			stored = append(stored, event)
		}
	}
	if len(stored) != 1 {
		t.Fatalf("host.view.killed records %v, want 1", stored)
	}
	if stored[0]["level"] != "warn" || stored[0]["class"] != "lifecycle" {
		t.Fatalf("host.view.killed record %v", stored[0])
	}
}
