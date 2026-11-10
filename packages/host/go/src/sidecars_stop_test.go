package host

import (
	"context"
	"net"
	"testing"
)

// A stop sends close-owner without waiting for room in the queue of the service: a full queue fails the close at once and ends the
// connection (docs/spec/persistent-services.md#closing-and-recovery).
// contract: sidecars-transport.stop.waits-for-no-room
func TestAStopOfAPersistentServiceWaitsForNoRoomInItsQueue(t *testing.T) {
	c, err := NewSidecars(nil, t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	local, peer := net.Pipe()
	t.Cleanup(func() {
		if err := peer.Close(); err != nil {
			t.Error(err)
		}
	})
	process := &sidecar{name: "fixture-service", persistent: true, conn: local, outbox: make(chan queuedLine, 1),
		closeWaiters: map[string]chan error{}}
	process.outbox <- queue([]byte("{}\n"))
	// A close that waits for room in the full queue does not return, and the check stops at the limit of its runner.
	if err := c.closePersistentOwner(process, context.Background()); err == nil {
		t.Fatal("the close of a service whose queue is full succeeded")
	}
	process.responseMutex.Lock()
	ended := process.transportClosed
	process.responseMutex.Unlock()
	if !ended {
		t.Fatal("the close failed on the full queue and left the connection open")
	}
}

// A present that waits for the main thread ends when the sidecars stop, a presentation that the main thread runs later does not
// wait, and a present after the stop is refused without a step (docs/spec/sidecars.md#declaration-and-startup).
// contract: images.presentation.ends-with-the-sidecar-stop
func TestAPresentThatWaitsForTheMainThreadEndsWithTheStop(t *testing.T) {
	c, err := NewSidecars(nil, t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	// The main thread holds each step and does not run it, as the main thread that runs the stop at exit does.
	held := make(chan func(), 1)
	step := func(task func()) { held <- task }
	answered := make(chan error, 1)
	go func() { answered <- c.presents.present(func() error { return nil }, step) }()
	task := <-held
	c.Stop()
	// A present that still waits for the main thread does not answer, and the check stops at the limit of its runner.
	if err := <-answered; err == nil || err.Error() != presentsRefused {
		t.Fatalf("the present ended with %v, want %q", err, presentsRefused)
	}
	task()
	refused := c.presents.present(func() error {
		t.Error("a present after the stop ran")
		return nil
	}, func(func()) { t.Error("a present after the stop took a step") })
	if refused == nil || refused.Error() != presentsRefused {
		t.Fatalf("a present after the stop ended with %v, want %q", refused, presentsRefused)
	}
}
