package host

import (
	"encoding/json"
	"testing"
)

// contract: sidecars.native-view-removal.closes-stdio-session
func TestNativeViewRemovalStillClosesAStandardIOSession(t *testing.T) {
	s := sidecarSessionSurfaces(t)
	c := s.sidecars
	c.stopped = false
	const surface = "tab-standard"
	process := &sidecar{
		name:         "fixture-standard",
		outbox:       make(chan queuedLine, 2),
		closeWaiters: map[string]chan error{},
		retained:     map[string]int{},
		surfaces:     map[string]bool{surface: true},
	}
	c.running[process.name] = process
	c.owners[surface] = s
	c.roots[surface] = "/fixture/root"

	s.closeRemovedSurface(surface)

	select {
	case line := <-process.outbox:
		var request sidecarRequest
		if err := json.Unmarshal(line.bytes, &request); err != nil {
			t.Fatalf("standard sidecar close request: %v", err)
		}
		if request.Surface != surface || !request.Closed {
			t.Fatalf("standard sidecar request: %+v, want closed %q", request, surface)
		}
	default:
		t.Fatal("native-view removal did not close the standard-I/O session")
	}
}
