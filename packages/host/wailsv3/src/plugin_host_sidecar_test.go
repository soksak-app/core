package host

// The sidecar sessions of a plugin host against a window without a process (docs/plans/plugin-host-routes.md rules 2 and 3).
// The fixtures use the names probe and fixture-* only: core names no real plugin or sidecar.

import (
	"encoding/json"
	"strings"
	"testing"
)

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
		sidecars: c,
	}
}

// contract: plugin-host.sidecar.send-checks
func TestPluginHostSidecarSendPassesTheChecksOfAHeldProject(t *testing.T) {
	s := sidecarSessionSurfaces(t)
	err := s.pluginHostSidecarSend(PluginHostSidecarSendRequest{Plugin: "probe", Sidecar: "fixture-sidecar", ID: "plugin:probe:project-a:fixture-sidecar", Body: json.RawMessage(`{"operation":"list"}`)})
	if err == nil || err.Error() != "sidecars are stopped" {
		t.Fatalf("send of a held project: %v, want the stop of the sidecars after the checks", err)
	}
}

// contract: plugin-host.sidecar.send-checks
func TestPluginHostSidecarSendRefusesAnUnheldOrRootlessProjectAndAnUndeclaredSidecar(t *testing.T) {
	s := sidecarSessionSurfaces(t)
	cases := []struct {
		name string
		req  PluginHostSidecarSendRequest
		want string
	}{
		{"an unheld project", PluginHostSidecarSendRequest{Plugin: "probe", Sidecar: "fixture-sidecar", ID: "plugin:probe:project-b:fixture-sidecar"},
			"plugin host probe: project project-b is not held by this window"},
		{"a project without a folder", PluginHostSidecarSendRequest{Plugin: "probe", Sidecar: "fixture-sidecar", ID: "plugin:probe:project-empty:fixture-sidecar"},
			"plugin host probe: project project-empty has no folder"},
		{"a sidecar the plugin does not depend on", PluginHostSidecarSendRequest{Plugin: "probe", Sidecar: "other-sidecar", ID: "plugin:probe:project-a:other-sidecar"},
			"plugin host probe cannot use sidecar other-sidecar"},
		{"a session of another plugin", PluginHostSidecarSendRequest{Plugin: "probe", Sidecar: "fixture-sidecar", ID: "plugin:other:project-a:fixture-sidecar"},
			"plugin host probe cannot use sidecar session plugin:other:project-a:fixture-sidecar"},
		{"a session with an extra part", PluginHostSidecarSendRequest{Plugin: "probe", Sidecar: "fixture-sidecar", ID: "plugin:probe:project-a:fixture-sidecar:x"},
			"plugin host probe cannot use sidecar session plugin:probe:project-a:fixture-sidecar:x"},
	}
	for _, tc := range cases {
		err := s.pluginHostSidecarSend(tc.req)
		if err == nil || err.Error() != tc.want {
			t.Fatalf("%s: %v, want %q", tc.name, err, tc.want)
		}
	}
}

// contract: plugin-host.sidecar.surface-refusal
func TestSurfaceSidecarSendRefusesThePluginSessions(t *testing.T) {
	s := sidecarSessionSurfaces(t)
	err := s.SidecarSend("fixture-sidecar", "plugin:probe:project-a:fixture-sidecar", json.RawMessage(`{"operation":"list"}`), nil)
	if err == nil || !strings.Contains(err.Error(), "sidecar session plugin:probe:project-a:fixture-sidecar is reserved for a plugin host") {
		t.Fatalf("a surface send to a plugin session: %v, want the reserved refusal", err)
	}
}

// A plugin session first sent while the service of a retain starts is kept by that retain (docs/plans/plugin-host-routes.md
// rule 7, F229-7). The test answers the retain line that it reads from the outbox of the running fixture service.
// contract: plugin-host.sidecar.retain-during-start
func TestRetainKeepsASessionFirstSentDuringTheStart(t *testing.T) {
	const session = "plugin:probe:project-a:fixture-sidecar"
	s := sidecarSessionSurfaces(t)
	c := s.sidecars
	c.stopped = false
	c.persistent["fixture-sidecar"] = true
	service := &sidecar{name: "fixture-sidecar", persistent: true, outbox: make(chan queuedLine, 4), closeWaiters: map[string]chan error{}, retained: map[string]int{}}
	c.running["fixture-sidecar"] = service
	// RetainSending runs after the service is ready, so the session is sent while the service starts.
	c.RetainSending = func(string) {
		c.mu.Lock()
		c.roots[session] = "/fixture/root"
		c.mu.Unlock()
	}
	done := make(chan error, 1)
	go func() {
		_, err := c.Retain([]RetainedSurface{{Surface: "fixture-surface", Root: "/fixture/surface"}})
		done <- err
	}()
	line := <-service.outbox
	var sent struct {
		Request  string            `json:"request"`
		Surfaces []RetainedSurface `json:"surfaces"`
	}
	if err := json.Unmarshal(line.bytes, &sent); err != nil {
		t.Fatalf("the retain line: %v", err)
	}
	c.mu.Lock()
	waiter := service.closeWaiters[sent.Request]
	c.mu.Unlock()
	waiter <- nil
	if err := <-done; err != nil {
		t.Fatalf("retain: %v", err)
	}
	for _, item := range sent.Surfaces {
		if item.Surface == session {
			return
		}
	}
	t.Fatalf("the retain keeps %v, want the session %s that was first sent during the start", sent.Surfaces, session)
}

// Releasing a project closes the plugin sessions of that project that the holding window owns, and keeps the sessions of the
// projects that it still holds (docs/plans/plugin-host-routes.md rule 7).
// contract: plugin-host.sidecar.project-release
func TestProjectReleaseClosesThePluginSessionsOfThatProject(t *testing.T) {
	s := sidecarSessionSurfaces(t)
	c := s.sidecars
	c.stopped = false
	s.projects["project-b"] = "/fixture/other"
	h := &Host{owners: map[string]*Surfaces{"project-a": s, "project-b": s}, windows: map[uint]*Surfaces{}, sidecars: c}
	released := "plugin:probe:project-a:fixture-sidecar"
	held := "plugin:probe:project-b:fixture-sidecar"
	c.owners[released] = s
	c.owners[held] = s
	c.roots[released] = "/fixture/root"
	c.roots[held] = "/fixture/other"
	if err := h.ProjectRelease(json.RawMessage(`"project-a"`)); err != nil {
		t.Fatalf("release: %v", err)
	}
	if _, ok := c.owners[released]; ok {
		t.Fatalf("the session %s of the released project is still owned", released)
	}
	if _, ok := c.owners[held]; !ok {
		t.Fatalf("the session %s of a project that is still held was closed", held)
	}
}

// The close of a plugin host closes the plugin sessions of its plugin that the calling window owns, and no other session
// (docs/plans/plugin-host-routes.md rule 7, pluginHostSidecarClose).
// contract: plugin-host.sidecar.close
func TestPluginHostSidecarCloseClosesOnlyTheCallersSessionsOfThePlugin(t *testing.T) {
	s := sidecarSessionSurfaces(t)
	c := s.sidecars
	c.stopped = false
	other := &Surfaces{projects: map[string]string{}, sidecars: c}
	c.owners["plugin:probe:project-a:fixture-sidecar"] = s
	c.owners["plugin:other:project-a:fixture-sidecar"] = s
	c.owners["plugin:probe:project-a:fixture-sidecar-2"] = other
	c.owners["fixture-surface"] = s
	if err := s.pluginHostSidecarClose("probe"); err != nil {
		t.Fatalf("close: %v", err)
	}
	if _, ok := c.owners["plugin:probe:project-a:fixture-sidecar"]; ok {
		t.Fatal("the plugin session of the caller was not closed")
	}
	for _, kept := range []string{"plugin:other:project-a:fixture-sidecar", "plugin:probe:project-a:fixture-sidecar-2", "fixture-surface"} {
		if _, ok := c.owners[kept]; !ok {
			t.Fatalf("the session %s was closed, want it kept", kept)
		}
	}
}

// The page start closes every plugin session of the window and keeps its surfaces (docs/plans/plugin-host-routes.md rule 7).
// contract: plugin-host.sidecar.page-start
func TestPageStartClosesThePluginSessionsOfTheWindow(t *testing.T) {
	s := sidecarSessionSurfaces(t)
	c := s.sidecars
	c.stopped = false
	c.owners["plugin:probe:project-a:fixture-sidecar"] = s
	c.owners["fixture-surface"] = s
	c.closePluginSessions(s, func(pluginSession) bool { return true })
	if _, ok := c.owners["plugin:probe:project-a:fixture-sidecar"]; ok {
		t.Fatal("the plugin session of the window was not closed at the page start")
	}
	if _, ok := c.owners["fixture-surface"]; !ok {
		t.Fatal("a surface of the window was closed by the plugin session close")
	}
}
