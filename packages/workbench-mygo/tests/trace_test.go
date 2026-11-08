// The performance trace of the native workbench, which writes the page trace events of the registry that it holds under the names
// of the page (docs/spec/performance-trace.md#producers).
package workbench_test

import (
	"slices"
	"testing"
)

// registrationEvents returns the fields of the events workbench.trace.surface.registration that the host received.
func registrationEvents(stored *surfaceHost) []map[string]any {
	var fields []map[string]any
	for _, event := range stored.written("workbench.trace.surface.registration") {
		fields = append(fields, event["fields"].(map[string]any))
	}
	return fields
}

// names returns the field names of a registration event as strings.
func names(t *testing.T, fields map[string]any) []string {
	t.Helper()
	list, isList := fields["names"].([]any)
	if !isList {
		t.Fatalf("the event %v has no list names", fields)
	}
	var texts []string
	for _, name := range list {
		texts = append(texts, name.(string))
	}
	return texts
}

func TestTheTraceRecordsTheRegistrationsOfASurfaceAndItsClose(t *testing.T) {
	stored := &surfaceHost{}
	stored.classes = traceClasses()
	stored.common = map[string]any{"diagnostics.log": traceClasses(), "diagnostics.performance": true}
	r := newViewRelayOn(t, stored)
	surface := r.surface()
	r.call(surface, "runtime.command.register", map[string]any{"name": "textprobe.input"})
	r.emit("exposure-registered", map[string]any{"surface": surface, "closed": true})
	r.f.settle()
	r.f.until(func() bool { return len(registrationEvents(stored)) >= 2 })
	events := registrationEvents(stored)
	var registered, closed map[string]any
	for _, fields := range events {
		if fields["surface"] != surface {
			continue
		}
		switch fields["phase"] {
		case "registered":
			if fields["name"] == "textprobe.input" {
				registered = fields
			}
		case "closed":
			closed = fields
		}
	}
	if registered == nil || registered["kind"] != "command" || !slices.Contains(names(t, registered), "command textprobe.input") {
		t.Fatalf("the trace has no registration of textprobe.input by %s: %v", surface, events)
	}
	if want := stored.written("workbench.start")[0]["fields"].(map[string]any)["started_at"]; registered["timeOrigin"] != want {
		t.Fatalf("the registration has the time origin %v, want the start of the workbench %v", registered["timeOrigin"], want)
	}
	if _, has := registered["hasPort"]; has {
		t.Fatalf("the registration of a workbench without ports has hasPort: %v", registered)
	}
	if closed == nil || !slices.Contains(names(t, closed), "command textprobe.input") {
		t.Fatalf("the close of %s does not name the entries that it held: %v", surface, events)
	}
}

func TestTheTraceRecordsNoRegistrationWhileItIsOff(t *testing.T) {
	stored := &surfaceHost{}
	stored.classes = traceClasses()
	stored.common = map[string]any{"diagnostics.log": traceClasses()}
	r := newViewRelayOn(t, stored)
	surface := r.surface()
	r.call(surface, "runtime.command.register", map[string]any{"name": "textprobe.input"})
	// The registration arrives inside the host call exposureRegister, so its event would leave before the event of that call.
	r.f.until(func() bool {
		for _, event := range stored.written("workbench.call") {
			if event["fields"].(map[string]any)["name"] == "exposureRegister" {
				return true
			}
		}
		return false
	})
	if events := registrationEvents(stored); len(events) != 0 {
		t.Fatalf("a trace that is off recorded %v", events)
	}
}
