package host

import (
	"context"
	"encoding/json"
	"reflect"
	"strings"
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
		events:    func(string, any) {},
	}
	native := unsafe.Pointer(new(int))
	var start ViewStart
	if err := json.Unmarshal([]byte(`{"params":{"path":"a.md"},"origin":{"directory":"/work/one"},"project":{"id":"prj-one","root":"/work/one"},"declarations":{"commands":[]}}`), &start); err != nil {
		t.Fatalf("start values: %v", err)
	}
	spec := s.viewRecords().track("probe-surface", native, "probe", "ui/page.html", true)
	spec.directory, spec.folder = "/config/document-data", "/plugins/probe"
	if err := s.syncView("probe-surface", native, "probe", "ui/page.html", true, start); err != nil {
		t.Fatalf("first sync of the view: %v", err)
	}
	if len(fake.created) != 1 {
		t.Fatalf("views created: %d, want one", len(fake.created))
	}
	want := `window.sokSurface = Object.freeze({"surface":"probe-surface","params":{"path":"a.md"},"origin":Object.freeze({"directory":"/work/one"}),"project":Object.freeze({"id":"prj-one","root":"/work/one"}),"declarations":Object.freeze({"commands":[]})});`
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
		Start: &ViewStart{Project: &SurfaceProject{ID: "prj-one", Root: ""}},
	}}
	if _, err := CheckSyncRequest(SyncRequest{Titlebar: 40, Surfaces: entries}, map[string]SurfaceComposition{}, map[string]string{}); err == nil || err.Error() != `surface "probe": view start project root is empty` {
		t.Fatalf("empty project root: %v", err)
	}
	entries[0].Start = &ViewStart{Project: &SurfaceProject{Root: "/work/one"}}
	if _, err := CheckSyncRequest(SyncRequest{Titlebar: 40, Surfaces: entries}, map[string]SurfaceComposition{}, map[string]string{}); err == nil || err.Error() != `surface "probe": view start project id is empty` {
		t.Fatalf("empty project id: %v", err)
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
	if _, err := CheckSyncRequest(SyncRequest{Titlebar: 40, Surfaces: entries}, map[string]SurfaceComposition{}, map[string]string{}); err == nil || err.Error() != `surface "probe": plugin probe surface composition: kind hybrid is removed; the composition takes kind view` {
		t.Fatalf("a hybrid composition with start values: %v", err)
	}
}

// contract: view.start-values.declaration-table
func TestSyncRequestRequiresAndResolvesItsDeclarationTable(t *testing.T) {
	const surface = `"id":"probe","visible":true,"dim":false,"plugin":"probe","composition":{"kind":"view","page":"ui/page.html"},"x":0,"y":0,"w":10,"h":10,"start":{"params":{"path":"/work/one"},"origin":{"directory":"/work/one"},"project":{"id":"prj-one","root":"/work/one"}`
	request := func(table, index string) json.RawMessage {
		return json.RawMessage(`{"settled":true,"titlebar":40,"declarations":` + table + `,"surfaces":[{` + surface + `,"declarations":` + index + `}}]}`)
	}
	valid := request(`[{"commands":[{"name":"probe.command","params":{"path":"/work/one"}}]}]`, `0`)
	decoded, err := decodeSyncRequest(valid)
	if err != nil {
		t.Fatalf("valid declaration table: %v", err)
	}
	start := decoded.Surfaces[0].Start
	if string(start.Params) != `{"path":"/work/one"}` || string(start.Origin) != `{"directory":"/work/one"}` ||
		!reflect.DeepEqual(start.Project, &SurfaceProject{ID: "prj-one", Root: "/work/one"}) ||
		string(start.Declarations) != `{"commands":[{"name":"probe.command","params":{"path":"/work/one"}}]}` {
		t.Fatalf("resolved start values %+v", start)
	}
	script, err := surfaceStartScript("probe", *start)
	if err != nil || !strings.Contains(script, `"declarations":Object.freeze({"commands":[{"name":"probe.command","params":{"path":"/work/one"}}]})`) {
		t.Fatalf("resolved declarations were not retained for injection: %q, error %v", script, err)
	}
	if _, err := (&Host{}).SyncSurfaces(context.Background(), valid); err == nil || err.Error() != "host call has no window" {
		t.Fatalf("valid declaration table did not proceed to window lookup: %v", err)
	}
	for _, index := range []string{"-0", "1e0", "0.0", "true", `"0"`, "18446744073709551616"} {
		if _, err := decodeSyncRequest(request(`[{"commands":[]}]`, index)); err == nil {
			t.Errorf("non-integer or overflowing index %s was accepted", index)
		}
	}

	second := strings.Replace(surface, `"id":"probe"`, `"id":"probe-two"`, 1)
	paired := json.RawMessage(`{"settled":true,"titlebar":40,"declarations":[{"commands":[{"name":"probe.first"}]},{"commands":[{"name":"probe.second"}]}],"surfaces":[{` + surface + `,"declarations":0}},{` + second + `,"declarations":1}}]}`)
	pairedDecoded, err := decodeSyncRequest(paired)
	if err != nil || string(pairedDecoded.Surfaces[0].Start.Declarations) != `{"commands":[{"name":"probe.first"}]}` ||
		string(pairedDecoded.Surfaces[1].Start.Declarations) != `{"commands":[{"name":"probe.second"}]}` {
		t.Fatalf("same-plugin declarations resolved as %+v, error %v", pairedDecoded.Surfaces, err)
	}
	changed := request(`[{"commands":[{"name":"probe.changed"}]}]`, `0`)
	changedDecoded, err := decodeSyncRequest(changed)
	if err != nil || string(changedDecoded.Surfaces[0].Start.Declarations) != `{"commands":[{"name":"probe.changed"}]}` {
		t.Fatalf("new request declarations resolved as %+v, error %v", changedDecoded.Surfaces, err)
	}
	empty, err := decodeSyncRequest(json.RawMessage(`{"settled":true,"titlebar":40,"declarations":[],"surfaces":[]}`))
	if err != nil || len(empty.Surfaces) != 0 {
		t.Fatalf("empty declaration table without view starts was refused: %+v, error %v", empty, err)
	}
	for _, raw := range []json.RawMessage{
		json.RawMessage(`{"settled":true,"titlebar":40,"surfaces":[]}`),
		json.RawMessage(`{"settled":true,"titlebar":40,"declarations":null,"surfaces":[]}`),
	} {
		if _, err := (&Host{}).SyncSurfaces(context.Background(), raw); err == nil || !strings.Contains(err.Error(), "declarations") {
			t.Errorf("no-view request without a non-null declaration table returned %v", err)
		}
	}
	nonView := strings.Replace(surface, `"composition":{"kind":"view"`, `"composition":{"kind":"other"`, 1)
	if _, err := decodeSyncRequest(json.RawMessage(`{"settled":true,"titlebar":40,"declarations":[{"commands":[]}],"surfaces":[{` + nonView + `,"declarations":0}}]}`)); err == nil || !strings.Contains(err.Error(), "non-view composition") {
		t.Fatalf("non-view start values were not rejected explicitly: %v", err)
	}

	missingTable := json.RawMessage(`{"settled":true,"titlebar":40,"surfaces":[{` + surface + `,"declarations":0}}]}`)
	cases := []struct {
		name, table, index, want string
	}{
		{"null table", `null`, `0`, "request.declarations is missing"},
		{"object table", `{"commands":[]}`, `0`, "request.declarations must be an array"},
		{"non-object table entry", `[null]`, `0`, "request.declarations[0]"},
		{"array table entry", `[[]]`, `0`, "request.declarations[0]"},
		{"missing index", `[{"commands":[]}]`, ``, "request.surfaces[0].start.declarations"},
		{"null index", `[{"commands":[]}]`, `null`, "start.declarations is missing"},
		{"nested legacy object", `[{"commands":[]}]`, `{"commands":[]}`, "declarations must be a nonnegative integer index"},
		{"negative index", `[{"commands":[]}]`, `-1`, "declarations must be a nonnegative integer index"},
		{"fractional index", `[{"commands":[]}]`, `0.5`, "declarations must be a nonnegative integer index"},
		{"out-of-range index", `[{"commands":[]}]`, `1`, "declarations index 1 is out of range"},
		{"unused entry", `[{"commands":[]},{"dom":[]}]`, `0`, "request.declarations[1] is unused"},
	}
	if _, err := (&Host{}).SyncSurfaces(context.Background(), missingTable); err == nil || !strings.Contains(err.Error(), "declarations") {
		t.Fatalf("sync request without its declaration table returned %v, want a declaration-table error before window lookup", err)
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			var raw json.RawMessage
			if tc.name == "missing index" {
				raw = json.RawMessage(`{"settled":true,"titlebar":40,"declarations":` + tc.table + `,"surfaces":[{` + surface + `}}]}`)
			} else {
				raw = request(tc.table, tc.index)
			}
			_, err := (&Host{}).SyncSurfaces(context.Background(), raw)
			if err == nil || !strings.Contains(err.Error(), tc.want) {
				t.Fatalf("sync request returned %v, want an error containing %q before window lookup", err, tc.want)
			}
		})
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
		held := map[string]SurfaceComposition{surface.ID: surface.Composition}
		plugins := map[string]string{surface.ID: surface.Plugin}
		_, err := CheckSyncRequest(SyncRequest{Titlebar: 40, Surfaces: []Surface{surface}}, held, plugins)
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

// The origin directory is an absolute path in the one local form: a relative path, the // and /<letter>: prefixes and a NUL
// byte are refused with the same text, and an absolute local path is accepted.
// contract: view.start-values.refuses-a-missing-origin
func TestViewOriginDirectoryRefusesAPathThatIsNotLocalAbsolute(t *testing.T) {
	const notAbsolute = `surface "probe-surface": view start origin directory is not an absolute path`
	for _, path := range []string{"relative", `C:\x`, "/C:/x", "//server/share", "a\x00b"} {
		raw, err := json.Marshal(map[string]string{"directory": path})
		if err != nil {
			t.Fatalf("%q: origin fixture: %v", path, err)
		}
		if _, err := viewOriginDirectory("probe-surface", raw); err == nil || err.Error() != notAbsolute {
			t.Fatalf("directory %q: %v, want %q", path, err, notAbsolute)
		}
	}
	dir, err := viewOriginDirectory("probe-surface", json.RawMessage(`{"directory":"/a"}`))
	if err != nil || dir == nil || *dir != "/a" {
		t.Fatalf("absolute local directory: %v %v, want /a", dir, err)
	}
}
