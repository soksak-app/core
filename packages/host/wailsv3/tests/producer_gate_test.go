// The gate at the producers of the host (docs/spec/logging.md#classes-and-policy): a call that the policy does not store is not built
// into an event, and the writer counts it; a failed call is a warning and still passes a policy that stores the class from info on.
package host_test

import (
	"context"
	"encoding/json"
	"strings"
	"testing"
	"time"

	host "github.com/soksak-app/core/packages/host/wailsv3/src"
)

func narrowCalls(t *testing.T, log *host.EventLog, level string) {
	t.Helper()
	policy, err := host.ParseLogPolicy("policy", []byte(`{"schema":1,"classes":{"lifecycle":"trace","input":"trace","call":"`+level+`","io":"trace","frame":"trace"}}`))
	if err != nil {
		t.Fatal(err)
	}
	log.SetPolicy(policy, "file")
}

// gatedCounts returns the counts that log.gated reports, by class and level.
func gatedCounts(t *testing.T, log *host.EventLog) map[string]float64 {
	t.Helper()
	if err := log.Flush(5 * time.Second); err != nil {
		t.Fatal(err)
	}
	counts := map[string]float64{}
	for _, event := range readEventLog(t, log.Path()) {
		if event["event"] == "log.gated" {
			fields := event["fields"].(map[string]any)
			counts[fields["class"].(string)+"/"+fields["level"].(string)] += fields["count"].(float64)
		}
	}
	return counts
}

// contract: log.policy.binding-call-is-gated
func TestABindingCallThatThePolicyDoesNotStoreIsCountedAndAFailedOneIsStored(t *testing.T) {
	log := useEventLog(t)
	narrowCalls(t, log, "warn")
	bindings := newBindings(t)
	for index := 0; index < 3; index++ {
		if _, err := bindings.Call(context.Background(), "Echo", []json.RawMessage{json.RawMessage(`{"a":1}`)}, nil); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := bindings.Call(context.Background(), "Fail", []json.RawMessage{json.RawMessage(`1`)}, nil); err == nil {
		t.Fatal("the failing call succeeded")
	}
	calls := bindingCalls(t, log)
	if len(calls) != 1 || calls[0]["level"] != "warn" || calls[0]["fields"].(map[string]any)["name"] != "fail" {
		t.Fatalf("the stored calls: %v", calls)
	}
	if counts := gatedCounts(t, log); counts["call/debug"] != 3 || len(counts) != 1 {
		t.Fatalf("log.gated counted %v, want 3 calls of call/debug", counts)
	}
}

// contract: log.policy.endpoint-call-is-gated
func TestAnEndpointRequestThatThePolicyDoesNotStoreIsCounted(t *testing.T) {
	log := useEventLog(t)
	narrowCalls(t, log, "warn")
	_, address, _ := serve(t, newFakeBackend())
	conn := dial(t, address)
	call(t, conn, 1, "windows.list", nil)
	call(t, conn, 2, "windows.list", nil)
	if calls := endpointCalls(t, log); len(calls) != 0 {
		t.Fatalf("%d endpoint calls were stored: %v", len(calls), calls)
	}
	if counts := gatedCounts(t, log); counts["call/debug"] != 2 || len(counts) != 1 {
		t.Fatalf("log.gated counted %v, want 2 requests of call/debug", counts)
	}
}

// contract: log.policy.closed-gate-costs-a-branch
func TestAClosedGateCostsFarLessThanAnOpenOneAndStaysUnderALimit(t *testing.T) {
	options := eventLogOptions(t.TempDir())
	options.QueueEvents = 1 << 16
	options.QueueBytes = 1 << 26
	log, err := host.StartEventLog(options)
	if err != nil {
		t.Fatal(err)
	}
	const rounds = 20000
	fields := func() map[string]any {
		return map[string]any{"name": "echo", "args": "[{\"a\":1}]", "micros": 1, "ok": true, "truncated": false}
	}
	open := time.Now()
	for index := 0; index < rounds; index++ {
		log.Emit(host.LevelDebug, "host.binding.call", fields())
	}
	openEach := time.Since(open) / rounds
	narrowCalls(t, log, "warn")
	closed := time.Now()
	for index := 0; index < rounds; index++ {
		if log.Gate(host.ClassCall, host.LevelDebug) {
			t.Fatal("the gate is open")
		}
	}
	closedEach := time.Since(closed) / rounds
	t.Logf("an enqueue with the gate open: %v; the question of a closed gate: %v (%d rounds)", openEach, closedEach, rounds)
	// The limits are generous: the closed gate is a branch and an atomic add, so it is at most a few nanoseconds on a quiet machine,
	// and a machine under load runs it up to 100 times slower (the numbers on a quiet machine are recorded under F160.17).
	if closedEach > 25*time.Microsecond {
		t.Fatalf("a closed gate costs %v for each question, over the limit of 25 µs", closedEach)
	}
	if closedEach*4 >= openEach {
		t.Fatalf("a closed gate costs %v and an open enqueue %v: the closed gate is not far cheaper", closedEach, openEach)
	}
}

// contract: log.policy.producer-builds-nothing-for-a-closed-gate
func TestAClosedGateBuildsNoFieldsAtTheProducersOfTheHost(t *testing.T) {
	log := useEventLog(t)
	bindings := newBindings(t)
	args := []json.RawMessage{json.RawMessage(`{"a":1,"b":"` + strings.Repeat("x", 4000) + `"}`)}
	call := func() {
		if _, err := bindings.Call(context.Background(), "Echo", args, nil); err != nil {
			t.Fatal(err)
		}
	}
	open := testing.AllocsPerRun(40, call)
	narrowCalls(t, log, "warn")
	closed := testing.AllocsPerRun(40, call)
	if closed >= open {
		t.Fatalf("a call allocated %.0f times with the gate closed and %.0f times with the gate open", closed, open)
	}
	// The observation of the trace builds its fields only for a gate that is open.
	if _, err := host.PerformanceCommand(map[string]any{"action": "on"}); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _, _ = host.PerformanceCommand(map[string]any{"action": "off"}) })
	built := 0
	host.PerformanceObserve("host", func() map[string]any { built++; return map[string]any{"event": "probe"} })
	if built != 0 {
		t.Fatalf("the fields of an observation were built %d times although the policy does not store the class call at debug", built)
	}
}
