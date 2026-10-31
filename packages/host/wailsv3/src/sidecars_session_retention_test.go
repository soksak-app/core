package host

import (
	"encoding/json"
	"net"
	"reflect"
	"testing"
	"time"

	"github.com/wailsapp/wails/v3/pkg/application"
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
	// A declaration whose sidecar.json does not parse refuses the sidecar: the running service stays and is reported
	// without an installed version, and the change is notified once.
	declaration.Data = []byte("{")
	if err := c.Declare([]SidecarDeclaration{declaration}); err != nil {
		t.Fatal(err)
	}
	after := c.Status()
	if calls != 1 || before.Outdated[0].Installed != "0.0.7" || len(after.Outdated) != 1 || after.Outdated[0].Sidecar != "fixture-service" ||
		after.Outdated[0].Running == nil || *after.Outdated[0].Running != "0.0.6" || after.Outdated[0].Installed != "" || after.Outdated[0].Sessions != 1 {
		t.Fatalf("refused declaration: notifications %d, status %+v, before %+v", calls, after, before)
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

// sidecarSessionSurfaces returns a window that holds the project project-a with the root /fixture/root, and a Sidecars
// that declares fixture-sidecar as a dependency of the plugin probe. The Sidecars is stopped, so a send that passes every
// check returns "sidecars are stopped" before any process starts.
func sidecarSessionSurfaces(t *testing.T) *Surfaces {
	t.Helper()
	c := &Sidecars{
		declared:   map[string]string{"fixture-sidecar": "build/worker"},
		persistent: map[string]bool{},
		dependents: map[string][]string{"fixture-sidecar": {"probe"}},
		owners:     map[string]SidecarOwner{},
		roots:      map[string]string{},
		restarts:   map[string]*restartRecord{},
		running:    map[string]*sidecar{},
		starting:   map[string]chan struct{}{},
		closing:    map[string]map[string]int{},
		stopped:    true,
	}
	return &Surfaces{
		projects: map[string]string{"project-a": "/fixture/root", "project-empty": ""},
		shown:    "project-a",
		root:     "/fixture/root",
		sidecars: c,
		titles:   &titleRecord{},
	}
}

// titleRecord is the native window of a test: it records the title that the window is given, and no window exists.
type titleRecord struct{ title string }

func (r *titleRecord) SetTitle(title string) application.Window {
	r.title = title
	return nil
}

// contract: sidecars.retain.keeps-surface-first-sent-during-start
func TestRetainKeepsAnOrdinarySurfaceFirstSentDuringTheStart(t *testing.T) {
	s := sidecarSessionSurfaces(t)
	c := s.sidecars
	c.stopped = false
	c.persistent["fixture-sidecar"] = true
	const surface = "tab-during-retain-start"
	service := &sidecar{name: "fixture-sidecar", persistent: true, outbox: make(chan queuedLine, 4), closeWaiters: map[string]chan error{}, retained: map[string]int{}, surfaces: map[string]bool{}}
	c.running[service.name] = service
	c.RetainSending = func(name string) {
		if name != service.name {
			return
		}
		if err := c.Send(s, service.name, surface, json.RawMessage(`{"operation":"open"}`)); err != nil {
			t.Errorf("send ordinary surface during retain: %v", err)
		}
	}
	done := make(chan error, 1)
	go func() {
		_, err := c.Retain([]RetainedSurface{{Surface: "listed", Root: "/fixture/listed"}})
		done <- err
	}()
	<-service.outbox // open request emitted by RetainSending
	line := <-service.outbox
	var request struct {
		Request  string            `json:"request"`
		Surfaces []RetainedSurface `json:"surfaces"`
	}
	if err := json.Unmarshal(line.bytes, &request); err != nil {
		t.Fatalf("retain request: %v", err)
	}
	keepsSurface := false
	for _, item := range request.Surfaces {
		if item.Surface == surface && item.Root == "/fixture/root" {
			keepsSurface = true
		}
	}
	c.mu.Lock()
	waiter := service.closeWaiters[request.Request]
	service.retained[request.Request] = 0
	c.mu.Unlock()
	if waiter == nil {
		t.Fatal("retain request did not register its answer")
	}
	waiter <- nil
	if err := <-done; err != nil {
		t.Fatalf("retain: %v", err)
	}
	if !keepsSurface {
		t.Fatalf("retain surfaces %v omitted the ordinary session sent during start", request.Surfaces)
	}
}

// contract: sidecars.native-view-removal.retains-persistent-layout-session
func TestNativeViewRemovalRetainsPersistentSession(t *testing.T) {
	s := sidecarSessionSurfaces(t)
	c := s.sidecars
	c.stopped = false
	const persistentName = "fixture-persistent"
	const persistentSurface = "tab-retained"
	c.declared[persistentName] = "build/persistent-worker"
	c.persistent[persistentName] = true
	c.running[persistentName] = &sidecar{name: persistentName, persistent: true,
		outbox: make(chan queuedLine, 4), closeWaiters: map[string]chan error{}, retained: map[string]int{},
		surfaces: map[string]bool{persistentSurface: true}}
	c.persistentSurfaces = map[string]map[string]bool{persistentSurface: {persistentName: true}}
	c.owners[persistentSurface] = s
	c.roots[persistentSurface] = "/fixture/root"

	s.closeRemovedSurface(persistentSurface)

	if got := len(c.running[persistentName].outbox); got != 0 {
		t.Fatalf("persistent service received %d native-removal messages, want none", got)
	}
	if c.owners[persistentSurface] != s || c.roots[persistentSurface] != "/fixture/root" {
		t.Fatalf("persistent owner/root after native removal: owner=%v root=%q", c.owners[persistentSurface], c.roots[persistentSurface])
	}
}

// contract: sidecars.retain.closes-sessions-absent-from-layout
func TestRetainClosesPersistentSessionAbsentFromTheLayout(t *testing.T) {
	s := sidecarSessionSurfaces(t)
	c := s.sidecars
	c.stopped = false
	c.persistent["fixture-persistent"] = true
	service := &sidecar{name: "fixture-persistent", persistent: true, outbox: make(chan queuedLine, 4),
		closeWaiters: map[string]chan error{}, retained: map[string]int{}, surfaces: map[string]bool{"tab-removed": true}}
	c.running[service.name] = service
	c.owners["tab-removed"] = s
	c.roots["tab-removed"] = "/fixture/root"

	type retainResult struct {
		closed int
		err    error
	}
	done := make(chan retainResult, 1)
	go func() {
		closed, err := c.Retain([]RetainedSurface{})
		done <- retainResult{closed: closed, err: err}
	}()
	line := <-service.outbox
	var request struct {
		Request  string            `json:"request"`
		Surfaces []RetainedSurface `json:"surfaces"`
	}
	if err := json.Unmarshal(line.bytes, &request); err != nil {
		t.Fatalf("retain request: %v", err)
	}
	keepsRemoved := false
	for _, item := range request.Surfaces {
		if item.Surface == "tab-removed" {
			keepsRemoved = true
		}
	}
	c.mu.Lock()
	waiter := service.closeWaiters[request.Request]
	if !keepsRemoved {
		service.retained[request.Request] = 1
	}
	c.mu.Unlock()
	if waiter == nil {
		t.Fatal("retain request did not register its answer")
	}
	waiter <- nil
	result := <-done
	if result.err != nil {
		t.Fatalf("retain: %v", result.err)
	}
	if keepsRemoved {
		t.Fatal("retain kept tab-removed even though no project layout contains it")
	}
	if got := result.closed; got != 1 {
		t.Fatalf("persistent service closed %d removed sessions, want 1", got)
	}
	if _, ok := c.owners["tab-removed"]; ok {
		t.Fatal("logical retain kept the owner of tab-removed")
	}
	if _, ok := c.roots["tab-removed"]; ok {
		t.Fatal("logical retain kept the root of tab-removed")
	}
}

// contract: sidecars.restart.enable-clears-stops
func TestEnableOfAPluginClearsTheSidecarStopsOfItsDependencies(t *testing.T) {
	s := sidecarSessionSurfaces(t)
	c := s.sidecars
	c.stopped = false
	c.mu.Lock()
	c.restarts["fixture-sidecar"] = &restartRecord{}
	for i := 0; i < restartLimit; i++ {
		c.restarts["fixture-sidecar"].count(time.Now())
	}
	if !c.restartStopped("fixture-sidecar") {
		c.mu.Unlock()
		t.Fatal("the restart limit did not stop the sidecar before the enable")
	}
	c.mu.Unlock()
	h := &Host{windows: map[uint]*Surfaces{}, sidecars: c}
	h.notifyPlugins(PluginsChanged{Action: "enable", Plugin: "probe"})
	c.mu.Lock()
	stillStopped := c.restartStopped("fixture-sidecar")
	c.mu.Unlock()
	if stillStopped {
		t.Fatal("the enable of probe left the sidecar stop of its dependency in place")
	}
}
