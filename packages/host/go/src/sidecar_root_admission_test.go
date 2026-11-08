package host

import (
	"context"
	"encoding/json"
	"strings"
	"testing"
	"testing/synctest"
)

// contract: sidecars.window-send.start-rechecks-the-surface-root
func TestBackgroundSidecarAdmissionRechecksRootAfterProcessStart(t *testing.T) {
	s := sidecarSessionSurfaces(t)
	synctest.Test(t, func(t *testing.T) {
		c := s.sidecars
		c.stopped = false
		gate := make(chan struct{})
		c.starting["fixture-sidecar"] = gate
		service := &sidecar{name: "fixture-sidecar", outbox: make(chan queuedLine, 4), surfaces: map[string]bool{}, closeWaiters: map[string]chan error{}, retained: map[string]int{}}
		answers := make(chan error, 2)
		go func() {
			answers <- s.windowSidecarSend(context.Background(), service.name, "background-owner", json.RawMessage(`{"id":"a"}`), nil)
		}()
		synctest.Wait() // A has captured its root and is waiting in real processContext.
		s.mu.Lock()
		s.root = "/fixture/root-b"
		s.mu.Unlock()
		go func() {
			answers <- s.windowSidecarSend(context.Background(), service.name, "background-owner", json.RawMessage(`{"id":"b"}`), nil)
		}()
		synctest.Wait() // B also passed the initial root check before either can commit.
		c.mu.Lock()
		c.running[service.name] = service
		delete(c.starting, service.name)
		close(gate)
		c.mu.Unlock()
		synctest.Wait()
		accepted, refused := 0, 0
		for range 2 {
			if err := <-answers; err == nil {
				accepted++
			} else if strings.Contains(err.Error(), "mounted project differs from its retained session") {
				refused++
			} else {
				t.Errorf("unexpected admission failure: %v", err)
			}
		}
		if accepted != 1 || refused != 1 || len(service.outbox) != 1 {
			t.Fatalf("competing captured roots both committed: accepted=%d refused=%d outbound=%d", accepted, refused, len(service.outbox))
		}
		var request sidecarRequest
		if err := json.Unmarshal((<-service.outbox).bytes, &request); err != nil {
			t.Fatal(err)
		}
		if request.Root != c.roots["background-owner"] {
			t.Fatalf("actual queued root %q differs from committed root %q", request.Root, c.roots["background-owner"])
		}
	})
}
