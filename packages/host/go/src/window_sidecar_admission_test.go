package host

import (
	"context"
	"encoding/json"
	"errors"
	"strings"
	"testing"
	"testing/synctest"
	"unsafe"
)

// contract: sidecars.window-send.mount-during-start-ends-the-admission
func TestWindowSidecarAdmissionCannotEnterAViewMountedDuringProcessStart(t *testing.T) {
	testWindowSidecarMountDuringStart(t, false)
}

// contract: sidecars.window-send.mount-during-start-ends-the-admission
func TestWindowSidecarAdmissionCannotReviveAfterMountedViewRetires(t *testing.T) {
	testWindowSidecarMountDuringStart(t, true)
}

func testWindowSidecarMountDuringStart(t *testing.T, retire bool) {
	s, service, _ := mountedSidecarProject(t)
	const surface = "background-owner"
	synctest.Test(t, func(t *testing.T) {
		service.outbox = make(chan queuedLine, 4)
		c := s.sidecars
		gate := make(chan struct{})
		c.mu.Lock()
		delete(c.running, service.name)
		c.starting[service.name] = gate
		c.mu.Unlock()
		answer := make(chan error, 1)
		go func() {
			answer <- s.windowSidecarSend(context.Background(), service.name, surface, json.RawMessage(`{"operation":"list"}`), nil)
		}()
		synctest.Wait() // Real window send passed the no-view preflight and awaits startup.
		start := nullOriginStart()
		start.Project = &SurfaceProject{ID: "project-b", Root: "/fixture/project-b"}
		native := unsafe.Pointer(new(int))
		probe := s.viewRecords().specs["probe-surface"]
		spec := s.viewRecords().track(surface, native, "probe", "ui/page.html", true)
		spec.directory, spec.folder = probe.directory, probe.folder
		if err := s.syncView(surface, native, "probe", "ui/page.html", true, start); err != nil {
			t.Fatal(err)
		}
		if _, ok := s.documents.view(surface); !ok {
			t.Fatal("B did not actually mount")
		}
		if _, known := c.roots[surface]; known {
			t.Fatal("B must have sent no session request before admission resumes")
		}
		if retire {
			s.closeSurfaceDocuments(surface)
			if _, exists := s.documents.view(surface); exists {
				t.Fatal("B did not actually retire")
			}
			if _, exists := s.sourceOriginState().current(surface); exists {
				t.Fatal("B source remains active after retirement")
			}
		}
		c.mu.Lock()
		c.running[service.name] = service
		delete(c.starting, service.name)
		close(gate)
		c.mu.Unlock()
		synctest.Wait()
		if err := <-answer; err == nil || !strings.Contains(err.Error(), "requires viewSidecarSend") {
			t.Errorf("old background request entered mounted B: %v", err)
		}
		if len(service.outbox) != 0 || service.surfaces[surface] || c.owners[surface] != nil {
			t.Fatalf("old window request committed mounted-view ownership: outbound=%d session=%v hasOwner=%v", len(service.outbox), service.surfaces[surface], c.owners[surface] != nil)
		}
		if _, known := c.roots[surface]; known {
			t.Fatal("old window request retained its root for B")
		}
	})
}

// contract: sidecars.window-send.absence-ticket-ends-with-its-request, sidecars.window-send.other-surface-mount-keeps-the-admission
func TestWindowSidecarAbsenceTicketsEndWithTheActualRequest(t *testing.T) {
	for _, outcome := range []string{"success", "full outbox", "cancel", "unrelated source"} {
		t.Run(outcome, func(t *testing.T) {
			s, service, _ := mountedSidecarProject(t)
			synctest.Test(t, func(t *testing.T) {
				service.outbox = make(chan queuedLine, 1)
				c := s.sidecars
				ctx, cancel := context.WithCancel(context.Background())
				defer cancel()
				if outcome == "full outbox" {
					service.outbox <- queuedLine{}
				}
				answer := make(chan error, 1)
				var gate chan struct{}
				if outcome == "cancel" || outcome == "unrelated source" {
					gate = make(chan struct{})
					delete(c.running, service.name)
					c.starting[service.name] = gate
				}
				go func() {
					answer <- s.windowSidecarSend(ctx, service.name, "background-owner", json.RawMessage(`{"operation":"list"}`), nil)
				}()
				synctest.Wait()
				if gate != nil {
					origins := s.sourceOriginState()
					origins.mu.Lock()
					live := len(origins.absences["background-owner"])
					origins.mu.Unlock()
					if live != 1 {
						t.Fatalf("pending request owns %d absence tickets, want one", live)
					}
					if outcome == "cancel" {
						cancel()
					} else {
						generation, err := origins.create("unrelated-view")
						if err != nil {
							t.Fatal(err)
						}
						origins.retire("unrelated-view", generation)
					}
					c.mu.Lock()
					c.running[service.name] = service
					delete(c.starting, service.name)
					close(gate)
					c.mu.Unlock()
					synctest.Wait()
				}
				err := <-answer
				switch outcome {
				case "cancel":
					if !errors.Is(err, context.Canceled) {
						t.Fatalf("cancelled request: %v", err)
					}
				case "full outbox":
					if err == nil || !strings.Contains(err.Error(), "not keeping up") {
						t.Fatalf("full outbox request: %v", err)
					}
				default:
					if err != nil {
						t.Fatalf("valid background request: %v", err)
					}
				}
				origins := s.sourceOriginState()
				origins.mu.Lock()
				left := len(origins.absences)
				origins.mu.Unlock()
				if left != 0 {
					t.Fatalf("completed %s request retained %d source ticket groups", outcome, left)
				}
				if outcome == "cancel" || outcome == "full outbox" {
					if service.surfaces["background-owner"] || c.owners["background-owner"] != nil {
						t.Fatal("failed request committed a background session")
					}
				} else if len(service.outbox) != 1 {
					t.Fatalf("successful request produced %d outbound messages", len(service.outbox))
				}
			})
		})
	}
}
