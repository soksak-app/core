package host

import (
	"encoding/json"
	"testing"
	"unsafe"
)

// nullOriginStart is the start values of a view whose tab recorded no directory: its origin is {"directory": null}.
func nullOriginStart() ViewStart { return ViewStart{Origin: json.RawMessage(`{"directory":null}`)} }

// contract: view.start-values.first-script
// A view that the host creates receives, before its page loads, the document-start script that sets window.sokSurface to the
// frozen start values {surface, params, origin, project, declarations} of its surface, so the first page script reads them.
func TestViewCreationAddsTheStartValuesScriptBeforeTheLoad(t *testing.T) {
	clock := &fakeClock{}
	fake := &lifecyclePlatform{ended: map[unsafe.Pointer]func(){}, responsiveness: map[unsafe.Pointer]func(bool){}, scripts: map[unsafe.Pointer][]string{}}
	saved := system
	system = fake
	t.Cleanup(func() { system = saved })
	s := &Surfaces{
		documents: NewDocuments(),
		lifecycle: newViewLifecycle(clock.now),
		host:      &Host{configDir: "/config"},
	}
	native := unsafe.Pointer(new(int))
	start := ViewStart{
		Params:       json.RawMessage(`{"path":"a.md"}`),
		Origin:       json.RawMessage(`{"directory":"/work/one"}`),
		Project:      &SurfaceProject{Root: "/work/one"},
		Declarations: json.RawMessage(`{"commands":[]}`),
	}
	spec := s.viewRecords().track("probe-surface", native, "probe", "ui/page.html", true)
	spec.directory, spec.folder = "/config/document-data", "/plugins/probe"
	if err := s.syncView("probe-surface", native, "probe", "ui/page.html", true, start); err != nil {
		t.Fatalf("first sync of the view: %v", err)
	}
	if len(fake.created) != 1 {
		t.Fatalf("views created: %d, want one", len(fake.created))
	}
	want := `window.sokSurface = Object.freeze({"surface":"probe-surface","params":{"path":"a.md"},"origin":Object.freeze({"directory":"/work/one"}),"project":Object.freeze({"root":"/work/one"}),"declarations":Object.freeze({"commands":[]})});`
	scripts := fake.scripts[fake.created[0]]
	if len(scripts) != 2 {
		t.Fatalf("user scripts of the view: %q, want the theme script and the start values script", scripts)
	}
	found := false
	for _, script := range scripts {
		if script == want {
			found = true
		}
	}
	if !found {
		t.Fatalf("user scripts of the view hold no start values script %q: %q", want, scripts)
	}
	if len(fake.loadsBeforeScript) != 2 || fake.loadsBeforeScript[0] != 0 || fake.loadsBeforeScript[1] != 0 {
		t.Fatalf("loads before the scripts: %v, want none", fake.loadsBeforeScript)
	}
}

// The start values script carries the start values that the surface has none of as JSON null.
// contract: view.start-values.first-script
func TestSurfaceStartScriptCarriesAbsentValuesAsNull(t *testing.T) {
	want := `window.sokSurface = Object.freeze({"surface":"probe-surface","params":null,"origin":Object.freeze({"directory":null}),"project":null,"declarations":Object.freeze({})});`
	got, err := surfaceStartScript("probe-surface", nullOriginStart())
	if err != nil {
		t.Fatalf("start values script: %v", err)
	}
	if got != want {
		t.Fatalf("start values script %q, want %q", got, want)
	}
}

// The synchronization request of a view surface carries its start values, and a value of the wrong form is refused with its
// reason. A surface of another composition carries no start values.
// contract: view.start-values.first-script
func TestSyncRequestValidatesTheStartValuesOfAView(t *testing.T) {
	entries := []Surface{{
		ID: "probe", Plugin: "probe", Composition: SurfaceComposition{Kind: "view", Page: "ui/page.html"},
		Start: &ViewStart{Project: &SurfaceProject{Root: ""}},
	}}
	if _, err := CheckSyncRequest(SyncRequest{Titlebar: 40, Surfaces: entries}, map[string]SurfaceComposition{}, map[string]string{}); err == nil || err.Error() != `surface "probe": view start project root is empty` {
		t.Fatalf("empty project root: %v", err)
	}
	entries[0].Start = &ViewStart{Origin: json.RawMessage(`{"directory":""}`)}
	if _, err := CheckSyncRequest(SyncRequest{Titlebar: 40, Surfaces: entries}, map[string]SurfaceComposition{}, map[string]string{}); err == nil || err.Error() != `surface "probe": view start origin directory is empty` {
		t.Fatalf("empty origin directory: %v", err)
	}
	entries[0].Start = &ViewStart{Declarations: json.RawMessage(`[]`)}
	if _, err := CheckSyncRequest(SyncRequest{Titlebar: 40, Surfaces: entries}, map[string]SurfaceComposition{}, map[string]string{}); err == nil || err.Error() != `surface "probe": view start declarations are not an object` {
		t.Fatalf("declarations of another type: %v", err)
	}
	entries[0].Start = &ViewStart{Params: json.RawMessage(`{`)}
	if _, err := CheckSyncRequest(SyncRequest{Titlebar: 40, Surfaces: entries}, map[string]SurfaceComposition{}, map[string]string{}); err == nil || err.Error() != `surface "probe": view start params are not JSON` {
		t.Fatalf("params that are not JSON: %v", err)
	}
	entries[0].Composition = SurfaceComposition{Kind: "hybrid", Regions: []SurfaceRegion{{Name: "main", Kind: "image", Input: "dom", Sidecar: "probe"}}, Overlays: []string{}}
	if _, err := CheckSyncRequest(SyncRequest{Titlebar: 40, Surfaces: entries}, map[string]SurfaceComposition{}, map[string]string{}); err == nil || err.Error() != `surface "probe": only a view surface carries start values` {
		t.Fatalf("start values beside another composition: %v", err)
	}
}

// A view surface whose start values carry no origin, or an origin that is not {directory} with a path or null, is refused
// with its reason; the host never injects a directory in its place. The fixed form with a null directory is accepted.
// contract: view.start-values.refuses-a-missing-origin
func TestSyncRequestRefusesAViewWithoutAnOriginDirectory(t *testing.T) {
	const view = `"id":"probe","plugin":"probe","composition":{"kind":"view","page":"ui/page.html"}`
	const missing = `surface "probe": view start origin is missing`
	const malformed = `surface "probe": view start origin is not {directory} with a path or null`
	cases := []struct{ name, surface, want string }{
		{"no start values", `{` + view + `}`, missing},
		{"no origin", `{` + view + `,"start":{"params":null}}`, missing},
		{"null origin", `{` + view + `,"start":{"origin":null}}`, malformed},
		{"origin without directory", `{` + view + `,"start":{"origin":{}}}`, malformed},
		{"directory that is not a string", `{` + view + `,"start":{"origin":{"directory":1}}}`, malformed},
		{"origin with another member", `{` + view + `,"start":{"origin":{"directory":"/work/one","root":"/work/one"}}}`, malformed},
		{"null directory", `{` + view + `,"start":{"origin":{"directory":null}}}`, ""},
	}
	for _, tc := range cases {
		var surface Surface
		if err := json.Unmarshal([]byte(tc.surface), &surface); err != nil {
			t.Fatalf("%s: surface fixture: %v", tc.name, err)
		}
		_, err := CheckSyncRequest(SyncRequest{Titlebar: 40, Surfaces: []Surface{surface}}, map[string]SurfaceComposition{}, map[string]string{})
		if tc.want == "" {
			if err != nil {
				t.Fatalf("%s: %v, want accepted", tc.name, err)
			}
		} else if err == nil || err.Error() != tc.want {
			t.Fatalf("%s: %v, want %q", tc.name, err, tc.want)
		}
	}
	if _, err := surfaceStartScript("probe", ViewStart{}); err == nil {
		t.Fatalf("start values script without an origin: no error, want a refusal")
	}
}
