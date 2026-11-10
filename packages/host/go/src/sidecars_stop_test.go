package host

import (
	"context"
	"net"
	"os/exec"
	"testing"
	"time"
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
	process.outbox <- queue([]byte("{}\n"), time.Now())
	// A close that waits for room in the full queue does not return, and the check stops at the limit of its runner.
	if err := c.closePersistentOwner(process, context.Background(), false); err == nil {
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

// A stop ends the wait of a replacement for the end of the process of the replaced service: the wait returns while that process
// runs, and the replacement ends (docs/spec/persistent-services.md#updates).
// contract: sidecars-transport.replace.waits-for-the-end-of-the-service-process
func TestAStopEndsTheWaitOfAReplacement(t *testing.T) {
	c, err := NewSidecars(nil, t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	// The process of the replaced service reads its input, whose write end the check holds, so it runs until the check ends it
	// and ends with the check process also when the check is killed.
	service := exec.Command("cat")
	input, err := service.StdinPipe()
	if err != nil {
		t.Fatal(err)
	}
	if err := service.Start(); err != nil {
		t.Fatal(err)
	}
	exited := make(chan struct{})
	go func() {
		service.Wait()
		close(exited)
	}()
	t.Cleanup(func() {
		input.Close()
		<-exited
	})
	running, installed := "0.0.6", "0.0.7"
	c.mu.Lock()
	c.replacing["fixture-service"] = replacement{running: &running, installed: &installed, pid: service.Process.Pid}
	c.mu.Unlock()
	waited := make(chan struct{})
	go func() {
		c.awaitReplacedService("fixture-service")
		close(waited)
	}()
	// A stop that does not end the wait leaves it waiting, and the check stops at the limit of its runner.
	c.Stop()
	<-waited
	c.mu.Lock()
	_, replacing := c.replacing["fixture-service"]
	c.mu.Unlock()
	if replacing {
		t.Fatal("the replacement that the stop ended is still recorded")
	}
	select {
	case <-exited:
		t.Fatal("the wait ended by the exit of the service process and not by the stop")
	default:
	}
}
