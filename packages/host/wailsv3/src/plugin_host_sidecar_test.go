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

func TestPluginHostSidecarSendPassesTheChecksOfAHeldProject(t *testing.T) {
	s := sidecarSessionSurfaces(t)
	err := s.pluginHostSidecarSend(PluginHostSidecarSendRequest{Plugin: "probe", Sidecar: "fixture-sidecar", ID: "plugin:probe:project-a:fixture-sidecar", Body: json.RawMessage(`{"operation":"list"}`)})
	if err == nil || err.Error() != "sidecars are stopped" {
		t.Fatalf("send of a held project: %v, want the stop of the sidecars after the checks", err)
	}
}

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

func TestSurfaceSidecarSendRefusesThePluginSessions(t *testing.T) {
	s := sidecarSessionSurfaces(t)
	err := s.SidecarSend("fixture-sidecar", "plugin:probe:project-a:fixture-sidecar", json.RawMessage(`{"operation":"list"}`), nil)
	if err == nil || !strings.Contains(err.Error(), "sidecar session plugin:probe:project-a:fixture-sidecar is reserved for a plugin host") {
		t.Fatalf("a surface send to a plugin session: %v, want the reserved refusal", err)
	}
}
