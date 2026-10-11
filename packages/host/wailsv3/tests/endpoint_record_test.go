// The record of the endpoint methods (docs/spec/logging.md#entrances): every request of a client is the event
// `host.endpoint.call` with the performance trace off.
package host_test

import (
	"fmt"
	"strings"
	"testing"
	"time"

	host "github.com/soksak-app/core/packages/host/wailsv3/src"
)

// endpointCalls flushes the writer and returns the events `host.endpoint.call` that it stored, in order.
func endpointCalls(t *testing.T, log *host.EventLog) []map[string]any {
	t.Helper()
	if err := log.Flush(5 * time.Second); err != nil {
		t.Fatal(err)
	}
	var calls []map[string]any
	for _, event := range readEventLog(t, log.Path()) {
		if event["event"] == "host.endpoint.call" {
			calls = append(calls, event)
		}
	}
	return calls
}

// contract: endpoint.record.call-is-an-event
func TestAnEndpointRequestIsAnEventWhileTheTraceIsOff(t *testing.T) {
	log := useEventLog(t)
	if host.PerformanceEnabled() {
		t.Fatal("the performance trace is on")
	}
	_, address, _ := serve(t, newFakeBackend())
	conn := dial(t, address)
	call(t, conn, 1, "windows.list", nil)
	call(t, conn, 2, "status.get", map[string]any{"window": "main", "name": "core.layout"})
	call(t, conn, 3, "status.watch", map[string]any{"window": "main", "name": "core.layout"})
	calls := endpointCalls(t, log)
	if len(calls) != 3 {
		t.Fatalf("%d events host.endpoint.call, want 3: %v", len(calls), calls)
	}
	want := []struct{ name, args string }{
		{"windows.list", "null"},
		{"status.get", `{"name":"core.layout","window":"main"}`},
		{"status.watch", `{"name":"core.layout","window":"main"}`},
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

// contract: endpoint.record.failure-names-the-error
func TestAFailedEndpointRequestIsAWarningWithItsErrorText(t *testing.T) {
	log := useEventLog(t)
	_, address, _ := serve(t, newFakeBackend())
	conn := dial(t, address)
	reply := call(t, conn, 1, "status.get", map[string]any{"window": "absent", "name": "core.layout"})
	if reply.Error == nil {
		t.Fatalf("status.get of an absent window succeeded: %+v", reply)
	}
	calls := endpointCalls(t, log)
	if len(calls) != 1 {
		t.Fatalf("%d events host.endpoint.call, want 1: %v", len(calls), calls)
	}
	fields := calls[0]["fields"].(map[string]any)
	if calls[0]["level"] != "warn" || fields["name"] != "status.get" || fields["ok"] != false || fields["error"] != fmt.Sprintf("%d: %s", reply.Error.Code, reply.Error.Message) {
		t.Fatalf("event %v, reply error %+v", calls[0], reply.Error)
	}
}

// contract: endpoint.record.arguments-are-cut-before-copying
func TestTheArgumentsOfAnEndpointEventAreCutAtTheBound(t *testing.T) {
	log := useEventLog(t)
	_, address, _ := serve(t, newFakeBackend())
	conn := dial(t, address)
	// Multi-byte characters put the bound inside a character.
	name := "core." + strings.Repeat("é", 3000)
	call(t, conn, 1, "status.get", map[string]any{"window": "main", "name": name})
	calls := endpointCalls(t, log)
	if len(calls) != 1 {
		t.Fatalf("%d events host.endpoint.call, want 1", len(calls))
	}
	fields := calls[0]["fields"].(map[string]any)
	args := fields["args"].(string)
	if len(args) > host.CallTextBytes || len(args) < host.CallTextBytes-3 || fields["truncated"] != true {
		t.Fatalf("args of %d bytes, truncated %v; want at most %d bytes and true", len(args), fields["truncated"], host.CallTextBytes)
	}
}
