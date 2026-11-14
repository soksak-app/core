package host

import (
	"context"
	"encoding/json"
	"testing"
)

func encodedViewSidecarSend(t *testing.T, s *Surfaces, generation uint64) json.RawMessage {
	t.Helper()
	raw, err := json.Marshal(map[string]any{"source": "probe-surface", "generation": generation, "sidecar": "fixture-sidecar", "surface": "probe-surface", "body": map[string]string{"operation": "list"}, "cids": []string{}})
	if err != nil {
		t.Fatal(err)
	}
	return raw
}

// contract: sidecars.view-send.requires-a-safe-generation-and-its-own-surface
func TestViewSidecarSendRequiresTheOriginalSafeGenerationAndOwnSession(t *testing.T) {
	valid := `{"source":"probe-surface","generation":1,"sidecar":"fixture-sidecar","surface":"probe-surface","body":{},"cids":[]}`
	if _, err := viewSidecarSendRequestFrom(json.RawMessage(valid)); err != nil {
		t.Fatal(err)
	}
	for _, raw := range []string{
		`{"source":"probe-surface","sidecar":"fixture-sidecar","surface":"probe-surface","body":{},"cids":[]}`,
		`{"source":"probe-surface","generation":0,"sidecar":"fixture-sidecar","surface":"probe-surface","body":{},"cids":[]}`,
		`{"source":"probe-surface","generation":9007199254740992,"sidecar":"fixture-sidecar","surface":"probe-surface","body":{},"cids":[]}`,
		`{"source":"probe-surface","generation":"1","sidecar":"fixture-sidecar","surface":"probe-surface","body":{},"cids":[]}`,
		`{"source":"probe-surface","generation":null,"sidecar":"fixture-sidecar","surface":"probe-surface","body":{},"cids":[]}`,
		`{"source":"probe-surface","generation":1,"sidecar":"fixture-sidecar","surface":"other-session","body":{},"cids":[]}`,
	} {
		if _, err := viewSidecarSendRequestFrom(json.RawMessage(raw)); err == nil {
			t.Errorf("invalid source authority accepted: %s", raw)
		}
	}
}

// contract: sidecars.view-send.retired-generation-sends-nothing, sidecars.view-send.new-mount-sends-its-own-project
func TestViewSidecarSendNeverBorrowsTheSuccessorGenerationOrMountRoot(t *testing.T) {
	s, service, views := mountedSidecarProject(t)
	old, _ := s.documents.view("probe-surface")
	request, err := viewSidecarSendRequestFrom(encodedViewSidecarSend(t, s, old.generation))
	if err != nil {
		t.Fatal(err)
	}
	s.viewRecords().specs["probe-surface"].start.Project = &SurfaceProject{ID: "project-b", Root: "/fixture/project-b"}
	endView(t, s, views, viewTestEpoch)
	next, ok := s.documents.view("probe-surface")
	if !ok || next.generation == old.generation {
		t.Fatal("fixture did not replace A with B")
	}
	if err := s.sendViewSidecar(context.Background(), request); err == nil {
		t.Fatal("a queued original-A wire request borrowed current B")
	}
	if len(service.outbox) != 0 {
		t.Fatal("retired wire request entered the real sidecar outbox")
	}
	if _, known := s.sidecars.roots["probe-surface"]; known {
		t.Fatal("retired wire request registered a session root")
	}
	current, err := viewSidecarSendRequestFrom(encodedViewSidecarSend(t, s, next.generation))
	if err != nil {
		t.Fatal(err)
	}
	if err := s.sendViewSidecar(context.Background(), current); err != nil {
		t.Fatal(err)
	}
	select {
	case line := <-service.outbox:
		var sent sidecarRequest
		if err := json.Unmarshal(line.bytes, &sent); err != nil {
			t.Fatal(err)
		}
		if sent.Root != "/fixture/project-b" {
			t.Fatalf("B wire request has root %q", sent.Root)
		}
	default:
		t.Fatal("current B produced no actual sidecar request")
	}
}

// contract: sidecars.window-send.mounted-view-surface-is-refused
func TestWindowSidecarSendCannotImplicitlyAcquireAMountedViewGeneration(t *testing.T) {
	s, service, _ := mountedSidecarProject(t)
	if err := s.windowSidecarSend(context.Background(), service.name, "probe-surface", json.RawMessage(`{}`), nil); err == nil {
		t.Fatal("generic window send implicitly acquired a mounted view")
	}
	if len(service.outbox) != 0 {
		t.Fatal("generic window send reached mounted session")
	}
	if err := s.windowSidecarSend(context.Background(), service.name, "window-background-session", json.RawMessage(`{}`), nil); err != nil {
		t.Fatalf("explicit window-owned background session was refused: %v", err)
	}
	select {
	case line := <-service.outbox:
		var sent sidecarRequest
		if err := json.Unmarshal(line.bytes, &sent); err != nil {
			t.Fatal(err)
		}
		if sent.Surface != "window-background-session" || sent.Root != "/fixture/project-a" {
			t.Fatalf("wrong explicit background authority: %+v", sent)
		}
	default:
		t.Fatal("explicit window-owned background request was not sent")
	}
}
