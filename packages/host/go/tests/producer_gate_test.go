// The gate at the producers of the host (docs/spec/logging.md#classes-and-policy): a call that the policy does not store is not built
// into an event, and the writer counts it; a failed call is a warning and still passes a policy that stores the class from info on.
package host_test

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"
	"testing"
	"time"

	host "github.com/soksak-app/core/packages/host/go/src"
	"github.com/soksak-app/core/packages/host/go/tests/support"
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
	log := support.UseEventLog(t)
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
	log := support.UseEventLog(t)
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
func TestAClosedGateAllocatesNothingAndItsTimesArePrinted(t *testing.T) {
	options := support.EventLogOptions(t.TempDir())
	options.QueueEvents = 1 << 16
	options.QueueBytes = 1 << 26
	log, err := host.StartEventLog(options)
	if err != nil {
		t.Fatal(err)
	}
	support.StoreEveryLevel(t, log)
	const rounds = 20000
	fields := func() map[string]any {
		return map[string]any{"name": "echo", "args": "[{\"a\":1}]", "micros": 1, "ok": true, "truncated": false}
	}
	enqueue := func() { log.Emit(host.LevelDebug, "host.binding.call", fields()) }
	question := func() {
		if log.Gate(host.ClassCall, host.LevelDebug) {
			t.Fatal("the gate is open")
		}
	}
	// An enqueue with the gate open builds the fields and the owned event; the question of a closed gate is a branch and an
	// atomic add, which allocate nothing.
	enqueued := testing.AllocsPerRun(100, enqueue)
	open := time.Now()
	for index := 0; index < rounds; index++ {
		enqueue()
	}
	openEach := time.Since(open) / rounds
	narrowCalls(t, log, "warn")
	asked := testing.AllocsPerRun(100, question)
	closed := time.Now()
	for index := 0; index < rounds; index++ {
		question()
	}
	closedEach := time.Since(closed) / rounds
	// The times are a measurement, which the check prints and does not judge (the numbers on a quiet machine are recorded
	// under F160.17).
	t.Logf("an enqueue with the gate open: %v and %.0f allocations; the question of a closed gate: %v and %.0f allocations (%d rounds)",
		openEach, enqueued, closedEach, asked, rounds)
	if asked != 0 {
		t.Fatalf("the question of a closed gate allocated %.0f times", asked)
	}
	if enqueued == 0 {
		t.Fatal("an enqueue with the gate open allocated nothing, so the allocations tell nothing of the closed gate")
	}
}

// contract: log.policy.producer-builds-nothing-for-a-closed-gate
func TestAClosedGateBuildsNoFieldsAtTheProducersOfTheHost(t *testing.T) {
	log := support.UseEventLog(t)
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

// contract: log.policy.counts-each-second
func TestTheCountsOfAClosedGateAreReportedEachSecondAndAtAFlush(t *testing.T) {
	options := support.EventLogOptions(t.TempDir())
	options.QueueEvents = 1 << 12
	options.QueueBytes = 1 << 22
	log, err := host.StartEventLog(options)
	if err != nil {
		t.Fatal(err)
	}
	support.StoreEveryLevel(t, log)
	narrowCalls(t, log, "warn")
	// The least time between two reports is an input of the check: an hour, so every batch below comes before it, whatever
	// time the batches take.
	log.SetGatedReportInterval(time.Hour)
	slept := make(chan struct{}, 1)
	log.SetOnSleep(func(bool) {
		select {
		case slept <- struct{}{}:
		default:
		}
	})
	fields := map[string]any{"name": "echo", "args": "[]", "micros": 1, "ok": true, "truncated": false}
	emitted := 0
	// Each round refuses an event and stores a marker, and the round ends when the writer wrote the marker and slept, so the
	// refused events cross 20 written batches.
	for round := 0; round < 20; round++ {
		log.Emit(host.LevelDebug, "host.binding.call", fields)
		emitted++
		marker := fmt.Sprintf("marker-%d", round)
		log.Emit(host.LevelWarn, "host.binding.call", map[string]any{"name": marker, "args": "[]", "micros": 1, "ok": false, "truncated": false})
		awaitMarker(t, log, slept, marker)
	}
	reports := 0
	for _, event := range readEventLog(t, log.Path()) {
		if event["event"] == "log.gated" {
			reports++
		}
	}
	if reports != 0 {
		t.Fatalf("%d log.gated events before the least time between two reports passed", reports)
	}
	if counts := gatedCounts(t, log); counts["call/debug"] != float64(emitted) {
		t.Fatalf("counts %v after a flush, want call/debug %d", counts, emitted)
	}
}

// awaitMarker returns when a writer that slept has written the event whose name field is marker: the writer sleeps only when it
// wrote everything that was queued.
func awaitMarker(t *testing.T, log *host.EventLog, slept <-chan struct{}, marker string) {
	t.Helper()
	for {
		select {
		case <-slept:
		case <-time.After(support.Stall):
			t.Fatalf("the writer did not sleep after the marker %s within %v; the test stalled", marker, support.Stall)
		}
		for _, event := range readEventLog(t, log.Path()) {
			if fields, _ := event["fields"].(map[string]any); fields["name"] == marker {
				return
			}
		}
	}
}
