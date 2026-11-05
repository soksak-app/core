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
	_, err := method(nil, nil, json.RawMessage(params))
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
	before := forcedCollections()
	if err := runGCLoop(t, `{"on":true}`); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if err := runGCLoop(t, `{"on":false}`); err != nil {
			t.Error(err)
		}
	})
	for deadline := time.Now().Add(30 * time.Second); forcedCollections() < before+2; {
		if time.Now().After(deadline) {
			t.Fatalf("the forced collections rose from %d to %d within 30 s, want 2 more", before, forcedCollections())
		}
		time.Sleep(time.Millisecond)
	}
}

// contract: diagnostics.gc-loop.collects-until-stopped
func TestTheCollectionLoopAnswersItsStopAfterTheHeldCollectionReturned(t *testing.T) {
	previous := collectGarbage
	t.Cleanup(func() { collectGarbage = previous })
	var calls atomic.Int64
	entered, release := make(chan struct{}, 1), make(chan struct{})
	collectGarbage = func() {
		calls.Add(1)
		select {
		case entered <- struct{}{}:
		default:
		}
		<-release
	}
	if err := runGCLoop(t, `{"on":true}`); err != nil {
		t.Fatal(err)
	}
	<-entered
	// A second start while the loop is on starts no second goroutine.
	if err := runGCLoop(t, `{"on":true}`); err != nil {
		t.Fatal(err)
	}
	stopped := make(chan error, 1)
	go func() {
		method := diagnosticMethods["diagnostics.gc.loop"]
		_, err := method(nil, nil, json.RawMessage(`{"on":false}`))
		stopped <- err
	}()
	select {
	case err := <-stopped:
		t.Fatalf("the stop answered %v while a collection was held", err)
	case <-time.After(200 * time.Millisecond):
	}
	if got := calls.Load(); got != 1 {
		t.Fatalf("%d collections started while one was held, want 1", got)
	}
	close(release)
	if err := <-stopped; err != nil {
		t.Fatal(err)
	}
	answered := calls.Load()
	time.Sleep(50 * time.Millisecond)
	if got := calls.Load(); got != answered {
		t.Fatalf("%d collections started after the stop answered, want none", got-answered)
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
