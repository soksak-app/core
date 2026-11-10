//go:build diagnostics

package host

import (
	"encoding/json"
	"runtime/metrics"
	"sync/atomic"
	"testing"
	"time"
)

func runGCLoop(t *testing.T, params string) error {
	t.Helper()
	method := diagnosticMethods["diagnostics.gc.loop"]
	if method == nil {
		t.Fatal("diagnostics.gc.loop is not registered")
	}
	_, err := method(nil, nil, json.RawMessage(params), nil)
	return err
}

// forcedCollections reads the collections that a call of runtime.GC forced.
func forcedCollections() uint64 {
	sample := []metrics.Sample{{Name: "/gc/cycles/forced:gc-cycles"}}
	metrics.Read(sample)
	return sample[0].Value.Uint64()
}

// contract: diagnostics.gc-loop.collects-until-stopped
func TestTheCollectionLoopForcesCollectionsWhileItIsOn(t *testing.T) {
	// The loop collects through runtime.GC and tells each collection that returned.
	previous := collectGarbage
	t.Cleanup(func() { collectGarbage = previous })
	collected := make(chan struct{}, 2)
	collectGarbage = func() {
		previous()
		select {
		case collected <- struct{}{}:
		default:
		}
	}
	before := forcedCollections()
	if err := runGCLoop(t, `{"on":true}`); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if err := runGCLoop(t, `{"on":false}`); err != nil {
			t.Error(err)
		}
	})
	for range 2 {
		select {
		case <-collected:
		case <-time.After(30 * time.Second):
			t.Fatal("the loop returned from no collection within 30 s; the test stalled")
		}
	}
	if got := forcedCollections(); got < before+2 {
		t.Fatalf("the forced collections rose from %d to %d after two collections of the loop, want 2 more", before, got)
	}
}

// contract: diagnostics.gc-loop.collects-until-stopped
func TestTheCollectionLoopAnswersItsStopAfterTheHeldCollectionReturned(t *testing.T) {
	previous := collectGarbage
	t.Cleanup(func() { collectGarbage = previous })
	var calls atomic.Int64
	var returned atomic.Bool
	entered, release := make(chan struct{}, 1), make(chan struct{})
	collectGarbage = func() {
		calls.Add(1)
		select {
		case entered <- struct{}{}:
		default:
		}
		<-release
		returned.Store(true)
	}
	if err := runGCLoop(t, `{"on":true}`); err != nil {
		t.Fatal(err)
	}
	<-entered
	// A second start while the loop is on starts no second goroutine.
	if err := runGCLoop(t, `{"on":true}`); err != nil {
		t.Fatal(err)
	}
	if got := calls.Load(); got != 1 {
		close(release)
		t.Fatalf("%d collections started while one was held, want 1", got)
	}
	// The held collection returns only after the stop was asked, so a stop that answered without waiting for it finds it held.
	type answer struct {
		afterCollection bool
		calls           int64
	}
	asking := make(chan struct{})
	stopped := make(chan answer, 1)
	go func() {
		method := diagnosticMethods["diagnostics.gc.loop"]
		close(asking)
		if _, err := method(nil, nil, json.RawMessage(`{"on":false}`), nil); err != nil {
			t.Error(err)
		}
		stopped <- answer{returned.Load(), calls.Load()}
	}()
	<-asking
	close(release)
	got := <-stopped
	if !got.afterCollection {
		t.Fatal("the stop answered while a collection was held")
	}
	// The answer of the stop follows the return of the loop, so no collection can start after it.
	if after := calls.Load(); after != got.calls {
		t.Fatalf("%d collections started after the stop answered, want none", after-got.calls)
	}
}

// contract: diagnostics.gc-loop.collects-until-stopped
func TestTheCollectionLoopRequiresOn(t *testing.T) {
	err := runGCLoop(t, `{}`)
	if err == nil || err.Error() != "-32602: on is required" {
		t.Fatalf("a request without on answered %v", err)
	}
	if err := runGCLoop(t, `{"on":false}`); err != nil {
		t.Fatalf("a stop while the loop is off answered %v", err)
	}
}
