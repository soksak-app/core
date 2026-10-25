package host

import (
	"encoding/json"
	"net"
	"reflect"
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

// contract: sidecars.close.answer-ends-closing
func TestFastCloseAnswerPreservesBothClosingTransitions(t *testing.T) {
	s := sidecarSessionSurfaces(t)
	c := s.sidecars
	c.stopped = false
	const surface = "tab-standard"
	process := &sidecar{name: "fixture-standard", outbox: make(chan queuedLine, 2),
		surfaces: map[string]bool{surface: true}}
	c.running[process.name] = process
	c.owners[surface] = s
	c.roots[surface] = "/fixture/root"
	var snapshots [][]ClosingSurface
	c.ClosingChanged = func(value SidecarStatus) { snapshots = append(snapshots, value.Closing) }
	c.closeObserved(surface, false, func() {
		if failure := c.closeAnswered(process, surface, true, nil); failure != "" {
			t.Fatalf("controlled close answer: %s", failure)
		}
	})
	want := [][]ClosingSurface{{{Sidecar: process.name, Surface: surface}}, {}}
	if !reflect.DeepEqual(snapshots, want) {
		t.Fatalf("closing transitions = %v, want %v", snapshots, want)
	}
}

// outdatedSidecarsFixture holds a connected persistent session without starting a process.
func outdatedSidecarsFixture(t *testing.T, running, installed string) (*Sidecars, SidecarDeclaration, *sidecar) {
	t.Helper()
	declaration := SidecarDeclaration{Name: "fixture-service", Folder: t.TempDir(), Version: installed,
		Data: []byte(`{"executable":"service","displayName":"soksak://sidecar/probe","protocol":1,"transport":"persistent"}`)}
	c, err := NewSidecars([]SidecarDeclaration{declaration}, t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	process := &sidecar{name: declaration.Name, version: &running, persistent: true,
		surfaces: map[string]bool{"tab-fixture": true}, outbox: make(chan queuedLine, 2)}
	c.running[process.name] = process
	c.owners["tab-fixture"] = sidecarSessionSurfaces(t)
	c.roots["tab-fixture"] = "/fixture/root"
	return c, declaration, process
}

// contract: sidecars-transport.hello.reports-a-service-of-another-version
func TestDeclarationNotifiesEachOutdatedVersionChange(t *testing.T) {
	for _, item := range []struct {
		running, installed, next string
		want                     bool
	}{
		{"0.0.7", "0.0.7", "0.0.8", true},
		{"0.0.6", "0.0.7", "0.0.8", true},
		{"0.0.6", "0.0.7", "0.0.6", true},
		{"0.0.6", "0.0.7", "0.0.7", false},
	} {
		t.Run(item.running+"-"+item.installed+"-"+item.next, func(t *testing.T) {
			c, declaration, _ := outdatedSidecarsFixture(t, item.running, item.installed)
			var snapshots []SidecarStatus
			c.ClosingChanged = func(value SidecarStatus) { snapshots = append(snapshots, value) }
			declaration.Version = item.next
			if err := c.Declare([]SidecarDeclaration{declaration}); err != nil {
				t.Fatal(err)
			}
			wantCount := 0
			if item.want {
				wantCount = 1
			}
			if len(snapshots) != wantCount {
				t.Fatalf("version-change notifications = %v, want %d", snapshots, wantCount)
			}
			if item.want && !reflect.DeepEqual(snapshots[0], c.Status()) {
				t.Fatalf("notification = %+v, current status = %+v", snapshots[0], c.Status())
			}
		})
	}
	c, declaration, _ := outdatedSidecarsFixture(t, "0.0.6", "0.0.7")
	before := c.Status()
	calls := 0
	c.ClosingChanged = func(SidecarStatus) { calls++ }
	declaration.Data = []byte("{")
	if err := c.Declare([]SidecarDeclaration{declaration}); err == nil {
		t.Fatal("invalid declaration was accepted")
	}
	if calls != 0 || !reflect.DeepEqual(c.Status(), before) {
		t.Fatal("rejected declaration changed or announced status")
	}
}

// contract: sidecars-transport.hello.reports-a-service-of-another-version
func TestDisconnectNotifiesOutdatedRemovalWithoutPendingCloses(t *testing.T) {
	c, _, process := outdatedSidecarsFixture(t, "0.0.6", "0.0.7")
	var snapshots []SidecarStatus
	c.ClosingChanged = func(value SidecarStatus) { snapshots = append(snapshots, value) }
	c.mu.Lock()
	stale, _, _ := c.persistentConnectionEnded(&sidecar{name: process.name}, false)
	c.mu.Unlock()
	if stale || len(snapshots) != 0 {
		t.Fatal("stale disconnect changed or announced the current connection")
	}
	c.mu.Lock()
	current, _, _ := c.persistentConnectionEnded(process, false)
	c.mu.Unlock()
	if !current {
		t.Fatal("the connected process was not retired")
	}
	want := []SidecarStatus{{Closing: []ClosingSurface{}, Outdated: []OutdatedSidecar{}}}
	if !reflect.DeepEqual(snapshots, want) {
		t.Fatalf("disconnect notifications = %+v, want %+v", snapshots, want)
	}
}

// contract: sidecars-transport.hello.reports-a-service-of-another-version
func TestDetachNotifiesOutdatedRemovalWithoutPendingCloses(t *testing.T) {
	c, _, process := outdatedSidecarsFixture(t, "0.0.6", "0.0.7")
	local, peer := net.Pipe()
	t.Cleanup(func() {
		if err := peer.Close(); err != nil {
			t.Error(err)
		}
	})
	process.conn = local
	var snapshots []SidecarStatus
	c.ClosingChanged = func(value SidecarStatus) { snapshots = append(snapshots, value) }
	c.Detach()
	want := []SidecarStatus{{Closing: []ClosingSurface{}, Outdated: []OutdatedSidecar{}}}
	if !reflect.DeepEqual(snapshots, want) {
		t.Fatalf("detach notifications = %+v, want %+v", snapshots, want)
	}
	c.Detach()
	if len(snapshots) != 1 {
		t.Fatalf("repeated detach announced unchanged status: %+v", snapshots)
	}
}

// contract: sidecars.retain.closes-sessions-absent-from-layout
func TestRetainNotifiesOutdatedSessionCounts(t *testing.T) {
	c, _, _ := outdatedSidecarsFixture(t, "0.0.6", "0.0.7")
	var snapshots []SidecarStatus
	c.ClosingChanged = func(value SidecarStatus) { snapshots = append(snapshots, value) }
	c.mu.Lock()
	c.retainLayoutOwners(map[string]bool{"tab-fixture": true})
	c.mu.Unlock()
	if len(snapshots) != 0 {
		t.Fatal("retaining all owners announced unchanged status")
	}
	c.mu.Lock()
	c.retainLayoutOwners(map[string]bool{})
	c.mu.Unlock()
	if len(snapshots) != 1 || len(snapshots[0].Outdated) != 1 || snapshots[0].Outdated[0].Sessions != 0 {
		t.Fatalf("retained session-count notifications = %+v, want one zero-session status", snapshots)
	}
	c.mu.Lock()
	c.retainLayoutOwners(map[string]bool{})
	c.mu.Unlock()
	if len(snapshots) != 1 {
		t.Fatal("repeated retention announced unchanged status")
	}
}

// contract: sidecars.retain.closes-sessions-absent-from-layout
func TestReusedRetainedSurfaceNotifiesOutdatedSessionCount(t *testing.T) {
	c, _, _ := outdatedSidecarsFixture(t, "0.0.6", "0.0.7")
	owner := c.owners["tab-fixture"]
	c.mu.Lock()
	c.retainLayoutOwners(map[string]bool{})
	c.mu.Unlock()
	var snapshots []SidecarStatus
	c.ClosingChanged = func(value SidecarStatus) { snapshots = append(snapshots, value) }
	if err := c.Send(owner, "fixture-service", "tab-fixture", json.RawMessage(`{"operation":"open"}`)); err != nil {
		t.Fatal(err)
	}
	if len(snapshots) != 1 || len(snapshots[0].Outdated) != 1 || snapshots[0].Outdated[0].Sessions != 1 {
		t.Fatalf("reused session notifications = %+v, want one restored-session status", snapshots)
	}
}
