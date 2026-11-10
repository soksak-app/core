package host

import (
	"context"
	"net"
	"strings"
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
	process.outbox <- queue([]byte("{}\n"))
	ctx, cancel := context.WithTimeout(context.Background(), time.Minute)
	defer cancel()
	closed := make(chan error, 1)
	go func() { closed <- c.closePersistentOwner(process, ctx) }()
	select {
	case err := <-closed:
		if err == nil {
			t.Fatal("the close of a service whose queue is full succeeded")
		}
	case <-time.After(5 * time.Second):
		t.Fatal("the close waits for room in the full queue of the service")
	}
	process.responseMutex.Lock()
	ended := process.transportClosed
	process.responseMutex.Unlock()
	if !ended {
		t.Fatal("the close failed on the full queue and left the connection open")
	}
}

// A retain that the service does not answer within its limit removes its request (docs/spec/persistent-services.md#service-transport).
// contract: sidecars-transport.retain.limit-removes-the-request
func TestARetainPastItsLimitRemovesItsRequest(t *testing.T) {
	s := sidecarSessionSurfaces(t)
	c := s.sidecars
	c.stopped = false
	c.persistent["fixture-persistent"] = true
	c.declared["fixture-persistent"] = "build/worker"
	installedVersion := ""
	service := &sidecar{name: "fixture-persistent", version: &installedVersion, persistent: true, outbox: make(chan queuedLine, 4),
		closeWaiters: map[string]chan error{}, retained: map[string]int{}, surfaces: map[string]bool{"tab-kept": true}}
	c.running[service.name] = service
	c.owners["tab-kept"] = s
	c.roots["tab-kept"] = "/fixture/root"
	done := make(chan error, 1)
	go func() {
		_, err := c.Retain([]RetainedSurface{{Surface: "tab-kept", Root: "/fixture/root", Plugin: "probe"}})
		done <- err
	}()
	<-service.outbox
	select {
	case err := <-done:
		if err == nil || !strings.Contains(err.Error(), "retain was not answered") {
			t.Fatalf("an unanswered retain ended with %v", err)
		}
	case <-time.After(30 * time.Second):
		t.Fatal("the unanswered retain did not end at its limit")
	}
	c.mu.Lock()
	waiting := len(service.closeWaiters)
	c.mu.Unlock()
	if waiting != 0 {
		t.Fatalf("the retain ended at its limit and left %d waiters of its request", waiting)
	}
}
