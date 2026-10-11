// The record of the host calls of a page (docs/spec/logging.md#entrances): every call through the one bound method of the
// host is the event `host.binding.call` with the performance trace off.
package host_test

import (
	"context"
	"encoding/json"
	"errors"
	"strings"
	"testing"
	"time"

	host "github.com/soksak-app/core/packages/host/wailsv3/src"
)

// bindingTarget is a host with one method of each shape that the entrance calls.
type bindingTarget struct{}

func (bindingTarget) Echo(ctx context.Context, value json.RawMessage) (any, error) {
	return map[string]any{"echo": value}, nil
}

func (bindingTarget) ClipboardPersistPNG(value json.RawMessage) error { return nil }

func (bindingTarget) Fail(value json.RawMessage) error { return errors.New("the request is refused") }

func (bindingTarget) Pair(first, second json.RawMessage) error { return nil }

func (bindingTarget) Stop() {}

func (bindingTarget) Explode(value json.RawMessage) error { panic("the method failed") }

// bindingCalls flushes the writer and returns the events `host.binding.call` that it stored, in order.
func bindingCalls(t *testing.T, log *host.EventLog) []map[string]any {
	t.Helper()
	if err := log.Flush(5 * time.Second); err != nil {
		t.Fatal(err)
	}
	var calls []map[string]any
	for _, event := range readEventLog(t, log.Path()) {
		if event["event"] == "host.binding.call" {
			calls = append(calls, event)
		}
	}
	return calls
}

func newBindings(t *testing.T) *host.Bindings {
	t.Helper()
	bindings, err := host.NewBindings(bindingTarget{})
	if err != nil {
		t.Fatal(err)
	}
	return bindings
}

// contract: binding.record.call-is-an-event
func TestABindingCallIsAnEventWhileTheTraceIsOff(t *testing.T) {
	log := useEventLog(t)
	if host.PerformanceEnabled() {
		t.Fatal("the performance trace is on")
	}
	bindings := newBindings(t)
	result, err := bindings.Call(context.Background(), "Echo", []json.RawMessage{json.RawMessage(`{"a":1}`)})
	if err != nil || result == nil {
		t.Fatalf("Echo returned %v, %v", result, err)
	}
	if _, err := bindings.Call(context.Background(), "ClipboardPersistPNG", []json.RawMessage{json.RawMessage(`"x"`)}); err != nil {
		t.Fatal(err)
	}
	if _, err := bindings.Call(context.Background(), "Stop", nil); err != nil {
		t.Fatal(err)
	}
	calls := bindingCalls(t, log)
	if len(calls) != 3 {
		t.Fatalf("%d events host.binding.call, want 3: %v", len(calls), calls)
	}
	want := []struct{ name, args string }{
		{"echo", `[{"a":1}]`},
		{"clipboard_persist_png", `["x"]`},
		{"stop", `[]`},
	}
	for i, c := range calls {
		fields := c["fields"].(map[string]any)
		if c["layer"] != "host" || c["level"] != "debug" || fields["name"] != want[i].name || fields["ok"] != true ||
			fields["truncated"] != false || fields["micros"].(float64) < 0 {
			t.Fatalf("event %d is %v", i, c)
		}
		if _, hasError := fields["error"]; hasError {
			t.Fatalf("event %d has an error: %v", i, c)
		}
		if fields["args"] != want[i].args {
			t.Fatalf("event %d args %q, want %q", i, fields["args"], want[i].args)
		}
	}
}

// contract: binding.record.failure-names-the-error
func TestAFailedBindingCallIsAWarningWithItsErrorText(t *testing.T) {
	log := useEventLog(t)
	bindings := newBindings(t)
	_, err := bindings.Call(context.Background(), "Fail", []json.RawMessage{json.RawMessage(`null`)})
	if err == nil {
		t.Fatal("Fail succeeded")
	}
	calls := bindingCalls(t, log)
	if len(calls) != 1 {
		t.Fatalf("%d events host.binding.call, want 1: %v", len(calls), calls)
	}
	fields := calls[0]["fields"].(map[string]any)
	if calls[0]["level"] != "warn" || fields["name"] != "fail" || fields["ok"] != false || fields["error"] != "-32603: "+err.Error() {
		t.Fatalf("event %v, error %v", calls[0], err)
	}
}

// contract: binding.record.refusal-names-the-error
func TestARefusedBindingCallIsAWarningWithItsErrorText(t *testing.T) {
	log := useEventLog(t)
	bindings := newBindings(t)
	_, unknown := bindings.Call(context.Background(), "Missing", nil)
	_, counted := bindings.Call(context.Background(), "Fail", nil)
	if unknown == nil || counted == nil {
		t.Fatalf("refusals %v and %v", unknown, counted)
	}
	calls := bindingCalls(t, log)
	if len(calls) != 2 {
		t.Fatalf("%d events host.binding.call, want 2: %v", len(calls), calls)
	}
	for i, want := range []struct{ name, text string }{{"missing", "-32603: " + unknown.Error()}, {"fail", "-32603: " + counted.Error()}} {
		fields := calls[i]["fields"].(map[string]any)
		if calls[i]["level"] != "warn" || fields["name"] != want.name || fields["ok"] != false || fields["error"] != want.text {
			t.Fatalf("event %d is %v, want name %s and error %q", i, calls[i], want.name, want.text)
		}
	}
}

// contract: binding.record.arguments-are-cut-before-copying
func TestTheArgumentsOfABindingEventAreCutAtTheBound(t *testing.T) {
	log := useEventLog(t)
	bindings := newBindings(t)
	// Multi-byte characters put the bound inside a character.
	big, err := json.Marshal(strings.Repeat("é", 3000))
	if err != nil {
		t.Fatal(err)
	}
	if _, err := bindings.Call(context.Background(), "Pair", []json.RawMessage{big, big}); err != nil {
		t.Fatal(err)
	}
	calls := bindingCalls(t, log)
	if len(calls) != 1 {
		t.Fatalf("%d events host.binding.call, want 1", len(calls))
	}
	fields := calls[0]["fields"].(map[string]any)
	args := fields["args"].(string)
	if len(args) > host.CallTextBytes || len(args) < host.CallTextBytes-3 || fields["truncated"] != true {
		t.Fatalf("args of %d bytes, truncated %v; want at most %d bytes and true", len(args), fields["truncated"], host.CallTextBytes)
	}
}

// contract: binding.record.unfinished-call-names-the-error
func TestABindingCallThatDoesNotReturnIsAWarning(t *testing.T) {
	log := useEventLog(t)
	bindings := newBindings(t)
	func() {
		defer func() {
			if recover() == nil {
				t.Error("the panic of the method did not reach the caller")
			}
		}()
		bindings.Call(context.Background(), "Explode", []json.RawMessage{json.RawMessage(`1`)})
	}()
	calls := bindingCalls(t, log)
	if len(calls) != 1 {
		t.Fatalf("%d events host.binding.call, want 1: %v", len(calls), calls)
	}
	fields := calls[0]["fields"].(map[string]any)
	if calls[0]["level"] != "warn" || fields["name"] != "explode" || fields["ok"] != false || fields["error"] != "-32603: the call ended without a result" {
		t.Fatalf("event %v", calls[0])
	}
}

// contract: binding.record.native-call-is-an-event
func TestACallOfANativeDocumentIsAnEvent(t *testing.T) {
	log := useEventLog(t)
	_, err := host.InvokeNative(nil, 7, "Theme", []json.RawMessage{json.RawMessage(`1`)})
	if err == nil {
		t.Fatal("Theme with an argument succeeded")
	}
	calls := bindingCalls(t, log)
	if len(calls) != 1 {
		t.Fatalf("%d events host.binding.call, want 1: %v", len(calls), calls)
	}
	fields := calls[0]["fields"].(map[string]any)
	if calls[0]["level"] != "warn" || fields["name"] != "theme" || fields["args"] != "[1]" || fields["ok"] != false || fields["error"] != "-32603: "+err.Error() {
		t.Fatalf("event %v, error %v", calls[0], err)
	}
}

// contract: binding.record.every-host-method-is-callable
func TestEveryMethodOfTheHostIsCallableThroughTheEntrance(t *testing.T) {
	useEventLog(t)
	bindings, err := host.NewBindings(&host.Host{})
	if err != nil {
		t.Fatal(err)
	}
	// A method of the host that the entrance reaches answers an argument it cannot decode with an error, not with a missing
	// method.
	_, err = bindings.Call(context.Background(), "SetShape", []json.RawMessage{json.RawMessage(`true`)})
	if err == nil || strings.HasPrefix(err.Error(), "unknown host call") {
		t.Fatalf("SetShape returned %v, want an argument error", err)
	}
}

type unsupportedTarget struct{}

func (unsupportedTarget) Odd(count int) error { return nil }

// contract: binding.record.unsupported-method-fails-at-start
func TestAMethodTheEntranceCannotCallFailsAtStart(t *testing.T) {
	if _, err := host.NewBindings(unsupportedTarget{}); err == nil || !strings.Contains(err.Error(), "Odd") {
		t.Fatalf("NewBindings returned %v, want an error that names the method Odd", err)
	}
}
