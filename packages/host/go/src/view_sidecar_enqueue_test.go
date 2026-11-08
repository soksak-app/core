package host

import (
	"context"
	"encoding/json"
	"testing"
	"testing/synctest"
)

// Hold actual process admission AFTER mounted A's host send has begun. The
// standard synctest barrier waits for its channel block, not a guessed delay.
// Retirement/remount must prevent a NEW A session from being enqueued later.
func TestMountedSidecarEnqueueCannotCreateSessionAfterItsGenerationRetires(t *testing.T) {
	s, service, fake := mountedSidecarProject(t)
	synctest.Test(t, func(t *testing.T) {
		c := s.sidecars
		service.outbox = make(chan queuedLine, 4) // channel ownership belongs to this synctest bubble
		gate := make(chan struct{})
		c.mu.Lock()
		delete(c.running, service.name)
		c.starting[service.name] = gate
		c.mu.Unlock()
		answer := make(chan error, 1)
		source, ok := s.documents.view("probe-surface")
		if !ok {
			t.Fatal("missing original source generation")
		}
		request := ViewSidecarSendRequest{Source: "probe-surface", Generation: source.generation, Sidecar: service.name, Surface: "probe-surface", Body: json.RawMessage(`{"operation":"list"}`)}
		go func() {
			answer <- s.sendViewSidecar(context.Background(), request)
		}()
		synctest.Wait() // actual send is durably blocked on the existing admission gate
		old, _ := s.documents.view("probe-surface")
		s.viewRecords().specs["probe-surface"].start.Project = &SurfaceProject{ID: "project-b", Root: "/fixture/project-b"}
		endView(t, s, fake)
		next, ok := s.documents.view("probe-surface")
		if !ok || next.generation == old.generation {
			t.Fatal("fixture did not retire A and mount new B")
		}
		c.mu.Lock()
		c.running[service.name] = service
		delete(c.starting, service.name)
		close(gate)
		c.mu.Unlock()
		synctest.Wait()
		if err := <-answer; err == nil {
			t.Error("retired mounted send was accepted after admission resumed")
		}
		if len(service.outbox) != 0 {
			t.Fatalf("retired generation created a sidecar session after retirement: %d actual outbound requests", len(service.outbox))
		}
		if _, known := c.roots["probe-surface"]; known {
			t.Fatal("retired send recorded a new session root")
		}
	})
}
