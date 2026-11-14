package host

import (
	"context"
	"encoding/json"
	"testing"
)

// A real ViewStart is recorded with the mount of the view (mountView); the Sidecars sender and outbound wire are production code, with
// a connected in-memory service and no child process.
func mountedSidecarProject(t *testing.T) (*Surfaces, *sidecar, *lifecycleViews) {
	t.Helper()
	start := nullOriginStart()
	start.Project = &SurfaceProject{ID: "project-a", Root: "/fixture/project-a"}
	s, views, _ := newLifecycleSurfacesWithStart(t, start)
	owner := sidecarSessionSurfaces(t)
	s.projects, s.shown, s.titles, s.sidecars = owner.projects, owner.shown, owner.titles, owner.sidecars
	s.root = "/fixture/project-a"
	s.projects["project-a"] = s.root
	s.sidecars.stopped = false
	service := &sidecar{name: "fixture-sidecar", outbox: make(chan queuedLine, 4), surfaces: map[string]bool{}, closeWaiters: map[string]chan error{}, retained: map[string]int{}}
	s.sidecars.running[service.name] = service
	if _, ok := s.sidecars.roots["probe-surface"]; ok {
		t.Fatal("fixture must precede the mount's first sidecar send")
	}
	return s, service, views
}

func requireMountedSidecarRoot(t *testing.T, s *Surfaces, service *sidecar, want string) {
	t.Helper()
	channel, ok := s.documents.view("probe-surface")
	if !ok {
		t.Fatal("missing actual source generation")
	}
	if err := s.sendViewSidecar(context.Background(), ViewSidecarSendRequest{Source: "probe-surface", Generation: channel.generation, Sidecar: service.name, Surface: "probe-surface", Body: json.RawMessage(`{"operation":"list","id":"first"}`)}); err != nil {
		t.Fatalf("a current mounted view lost its captured project before first send: %v", err)
	}
	select {
	case line := <-service.outbox:
		var request sidecarRequest
		if err := json.Unmarshal(line.bytes, &request); err != nil {
			t.Fatal(err)
		}
		if request.Root != want {
			t.Fatalf("sidecar outbound root=%q want exact mounted ViewStart root=%q (global current root must not be substituted)", request.Root, want)
		}
	default:
		t.Fatal("mounted source produced no actual sidecar request")
	}
}

// contract: sidecars.view-send.root-is-the-project-of-its-mount
func TestMountedViewFirstSidecarSendKeepsStartProjectAfterWindowProjectClears(t *testing.T) {
	s, service, _ := mountedSidecarProject(t)
	s.shown, s.root = "", ""
	requireMountedSidecarRoot(t, s, service, "/fixture/project-a")
}

// contract: sidecars.view-send.root-is-the-project-of-its-mount
func TestMountedViewFirstSidecarSendDoesNotBorrowAnotherCurrentProject(t *testing.T) {
	s, service, _ := mountedSidecarProject(t)
	s.shown, s.root = "project-b", "/fixture/project-b"
	requireMountedSidecarRoot(t, s, service, "/fixture/project-a")
}

// contract: view.origin.retired-callback-is-cancelled
func TestRetiredMountedViewCannotForwardALateSidecarRequest(t *testing.T) {
	s, service, _ := mountedSidecarProject(t)
	channel, ok := s.documents.view("probe-surface")
	if !ok {
		t.Fatal("missing actual mounted view")
	}
	if !s.documents.unregisterView("probe-surface", channel.generation) {
		t.Fatal("mount did not retire")
	}
	s.sourceOriginState().retire("probe-surface", channel.generation)
	accepted, err := s.viewMessageFrom("probe-surface", "probe", channel.generation, `{"message":{"id":1,"command":"runtime.sidecar.send","params":{"sidecar":"fixture-sidecar","id":"probe-surface","body":{"operation":"list"},"cids":[]}}}`)
	if err != nil || accepted {
		t.Fatalf("late retired request accepted=%v err=%v", accepted, err)
	}
	if len(service.outbox) != 0 {
		t.Fatal("retired generation opened a sidecar request")
	}
}

// contract: sidecars.view-send.new-mount-sends-its-own-project
func TestRecreatedViewSidecarRootUsesItsNewCommittedMountProject(t *testing.T) {
	s, service, views := mountedSidecarProject(t)
	old, _ := s.documents.view("probe-surface")
	spec := s.viewRecords().specs["probe-surface"]
	spec.start.Project = &SurfaceProject{ID: "project-b", Root: "/fixture/project-b"}
	endView(t, s, views, viewTestEpoch)
	current, ok := s.documents.view("probe-surface")
	if !ok || current.generation == old.generation {
		t.Fatal("the same logical surface did not receive a new actual mount generation")
	}
	s.shown, s.root = "project-c", "/fixture/project-c"
	requireMountedSidecarRoot(t, s, service, "/fixture/project-b")
}
