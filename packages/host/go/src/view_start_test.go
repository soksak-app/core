package host

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
)

// nullOriginStart is the start values of a view whose tab recorded no directory: its origin is {"directory": null}, and it
// is a tab view, so its section is null.
func nullOriginStart() ViewStart {
	var start ViewStart
	if err := json.Unmarshal([]byte(`{"origin":{"directory":null},"diagnostics":null,"section":null,"dialog":null}`), &start); err != nil {
		panic(err)
	}
	return start
}

// contract: view.start-values.first-script
// A view that the host creates receives, before its page loads, the document-start script that sets window.sokSurface to the
// frozen start values {surface, params, origin, project, declarations, diagnostics, section, dialog, levels, dataFolder} of its surface, so the first page script reads them.
func TestViewCreationAddsTheStartValuesScriptBeforeTheLoad(t *testing.T) {
	var start ViewStart
	if err := json.Unmarshal([]byte(`{"params":{"path":"a.md"},"origin":{"directory":"/work/one"},"project":{"id":"prj-one","root":"/work/one"},"declarations":{"commands":[]},"diagnostics":{"module":"ui/probe-diagnostics.js","exposes":{}},"section":null,"dialog":null}`), &start); err != nil {
		t.Fatalf("start values: %v", err)
	}
	opened := realViewProbe(t, Theme{}, start).waitCall(t, "probe.opened")
	want := map[string]any{
		"surface": "probe-surface", "params": map[string]any{"path": "a.md"}, "origin": map[string]any{"directory": "/work/one"},
		"project": map[string]any{"id": "prj-one", "root": "/work/one"}, "declarations": map[string]any{"commands": []any{}},
		"diagnostics": map[string]any{"module": "ui/probe-diagnostics.js", "exposes": map[string]any{}}, "section": nil, "dialog": nil,
		"levels": map[string]any{"call": "trace", "frame": "trace", "input": "trace", "io": "trace", "lifecycle": "trace"},
	}
	read, _ := opened["surface"].(map[string]any)
	folder, _ := read["dataFolder"].(string)
	if !filepath.IsAbs(folder) || !strings.HasSuffix(folder, "/plugin-data/probe") {
		t.Fatalf("the first script of the page read the data folder %v, want <configuration directory>/plugin-data/probe", read["dataFolder"])
	}
	want["dataFolder"] = folder
	if !reflect.DeepEqual(opened["surface"], want) {
		t.Fatalf("the first script of the page read the start values %v, want %v", opened["surface"], want)
	}
}

// The start values script carries the start values that the surface has none of as JSON null.
// contract: view.start-values.first-script
func TestSurfaceStartScriptCarriesAbsentValuesAsNull(t *testing.T) {
	want := `window.sokSurface = Object.freeze({"surface":"probe-surface","params":null,"origin":Object.freeze({"directory":null}),"project":null,"declarations":Object.freeze({}),"diagnostics":null,"section":null,"dialog":null,"levels":Object.freeze({"call":"error","frame":"error","input":"error","io":"error","lifecycle":"error"}),"dataFolder":"/data"});`
	got, err := surfaceStartScript("probe-surface", nullOriginStart(), defaultLevels(), "/data")
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
	entries[0].Start = &ViewStart{Origin: json.RawMessage(`{"directory":null}`)}
	if _, err := CheckSyncRequest(SyncRequest{Titlebar: 40, Surfaces: entries}, map[string]SurfaceComposition{}, map[string]string{}); err == nil || err.Error() != `surface "probe": view start diagnostics is missing` {
		t.Fatalf("missing diagnostics: %v", err)
	}
	entries[0].Start = &ViewStart{Origin: json.RawMessage(`{"directory":null}`), Diagnostics: json.RawMessage(`[]`)}
	if _, err := CheckSyncRequest(SyncRequest{Titlebar: 40, Surfaces: entries}, map[string]SurfaceComposition{}, map[string]string{}); err == nil || err.Error() != `surface "probe": view start diagnostics is not an object or null` {
		t.Fatalf("diagnostics of another type: %v", err)
	}
	entries[0].Start = &ViewStart{Origin: json.RawMessage(`{"directory":""}`), Diagnostics: json.RawMessage(`null`)}
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
	const surface = `"id":"probe","visible":true,"dim":false,"plugin":"probe","composition":{"kind":"view","page":"ui/page.html"},"x":0,"y":0,"w":10,"h":10,"start":{"params":{"path":"/work/one"},"origin":{"directory":"/work/one"},"project":{"id":"prj-one","root":"/work/one"},"diagnostics":null,"section":null,"dialog":null`
	request := func(table, index string) json.RawMessage {
		return json.RawMessage(`{"settled":true,"titlebar":40,"viewport":{"width":800,"height":600},"declarations":` + table + `,"surfaces":[{` + surface + `,"declarations":` + index + `}}]}`)
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
	script, err := surfaceStartScript("probe", *start, defaultLevels(), "/data")
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
	paired := json.RawMessage(`{"settled":true,"titlebar":40,"viewport":{"width":800,"height":600},"declarations":[{"commands":[{"name":"probe.first"}]},{"commands":[{"name":"probe.second"}]}],"surfaces":[{` + surface + `,"declarations":0}},{` + second + `,"declarations":1}}]}`)
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
	empty, err := decodeSyncRequest(json.RawMessage(`{"settled":true,"titlebar":40,"viewport":{"width":800,"height":600},"declarations":[],"surfaces":[]}`))
	if err != nil || len(empty.Surfaces) != 0 {
		t.Fatalf("empty declaration table without view starts was refused: %+v, error %v", empty, err)
	}
	for _, raw := range []json.RawMessage{
		json.RawMessage(`{"settled":true,"titlebar":40,"viewport":{"width":800,"height":600},"surfaces":[]}`),
		json.RawMessage(`{"settled":true,"titlebar":40,"viewport":{"width":800,"height":600},"declarations":null,"surfaces":[]}`),
	} {
		if _, err := (&Host{}).SyncSurfaces(context.Background(), raw); err == nil || !strings.Contains(err.Error(), "declarations") {
			t.Errorf("no-view request without a non-null declaration table returned %v", err)
		}
	}
	nonView := strings.Replace(surface, `"composition":{"kind":"view"`, `"composition":{"kind":"other"`, 1)
	if _, err := decodeSyncRequest(json.RawMessage(`{"settled":true,"titlebar":40,"viewport":{"width":800,"height":600},"declarations":[{"commands":[]}],"surfaces":[{` + nonView + `,"declarations":0}}]}`)); err == nil || !strings.Contains(err.Error(), "non-view composition") {
		t.Fatalf("non-view start values were not rejected explicitly: %v", err)
	}

	missingTable := json.RawMessage(`{"settled":true,"titlebar":40,"viewport":{"width":800,"height":600},"surfaces":[{` + surface + `,"declarations":0}}]}`)
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
		{"unused entry", `[{"commands":[]},{"element":[]}]`, `0`, "request.declarations[1] is unused"},
	}
	if _, err := (&Host{}).SyncSurfaces(context.Background(), missingTable); err == nil || !strings.Contains(err.Error(), "declarations") {
		t.Fatalf("sync request without its declaration table returned %v, want a declaration-table error before window lookup", err)
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			var raw json.RawMessage
			if tc.name == "missing index" {
				raw = json.RawMessage(`{"settled":true,"titlebar":40,"viewport":{"width":800,"height":600},"declarations":` + tc.table + `,"surfaces":[{` + surface + `}}]}`)
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
// contract: view.start-values.refuses-a-process-of-another-form
func TestSyncRequestRefusesAViewWithoutAnOriginDirectory(t *testing.T) {
	const view = `"id":"probe","plugin":"probe","composition":{"kind":"view","page":"ui/page.html"}`
	const missing = `surface "probe": view start origin is missing`
	const malformed = `surface "probe": view start origin is not {directory} with a path or null`
	cases := []struct{ name, surface, want string }{
		{"no origin", `{` + view + `,"start":{"params":null}}`, missing},
		{"null origin", `{` + view + `,"start":{"origin":null}}`, malformed},
		{"origin without directory", `{` + view + `,"start":{"origin":{}}}`, malformed},
		{"directory that is not a string", `{` + view + `,"start":{"origin":{"directory":1}}}`, malformed},
		{"origin with another member", `{` + view + `,"start":{"origin":{"directory":"/work/one","root":"/work/one"}}}`, malformed},
		{"no process", `{` + view + `,"start":{"origin":{"directory":null},"diagnostics":null,"section":null,"dialog":null}}`,
			`surface "probe": view start process "" is not plugin or view`},
		{"another process", `{` + view + `,"start":{"origin":{"directory":null},"diagnostics":null,"section":null,"dialog":null,"process":"window"}}`,
			`surface "probe": view start process "window" is not plugin or view`},
		{"null directory", `{` + view + `,"start":{"origin":{"directory":null},"diagnostics":null,"section":null,"dialog":null,"process":"plugin"}}`, ""},
		{"process of its own", `{` + view + `,"start":{"origin":{"directory":null},"diagnostics":null,"section":null,"dialog":null,"process":"view"}}`, ""},
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
	if _, err := surfaceStartScript("probe", ViewStart{}, defaultLevels(), "/data"); err == nil {
		t.Fatalf("start values script without an origin: no error, want a refusal")
	}
}

// checkViewSurface runs the sync check on the view surface whose JSON is surface and returns the refusal, or nil.
func checkViewSurface(t *testing.T, surface string) error {
	t.Helper()
	var decoded Surface
	if err := json.Unmarshal([]byte(surface), &decoded); err != nil {
		t.Fatalf("surface fixture: %v", err)
	}
	held := map[string]SurfaceComposition{decoded.ID: decoded.Composition}
	plugins := map[string]string{decoded.ID: decoded.Plugin}
	_, err := CheckSyncRequest(SyncRequest{Titlebar: 40, Surfaces: []Surface{decoded}}, held, plugins)
	return err
}

// The decoder of the page call keeps the null origin directory, diagnostic declaration and section of the start values as
// present raw values, which the start checks accept.
// contract: view.start-values.keeps-null-members
func TestSyncRequestDecoderKeepsTheNullStartValues(t *testing.T) {
	request, err := decodeSyncRequest(json.RawMessage(`{"settled":true,"titlebar":40,"viewport":{"width":800,"height":600},"declarations":[{"commands":[]}],
		"surfaces":[{"id":"spc-aaaaaa/left/probe.tree","x":0,"y":0,"w":10,"h":10,"visible":true,"dim":false,"plugin":"probe",
		"composition":{"kind":"view","page":"tree.html"},
		"start":{"params":null,"origin":{"directory":null},"project":null,"declarations":0,"diagnostics":null,"section":null,"dialog":null}}]}`))
	if err != nil {
		t.Fatalf("decode: %v", err)
	}
	start := request.Surfaces[0].Start
	if start == nil || string(start.Diagnostics) != "null" || string(start.Section) != "null" {
		t.Fatalf("start values %+v, want the null diagnostics and section kept", start)
	}
}

// A view surface whose start values carry no section is refused with its reason. The section is checked after the origin and
// the diagnostic declaration.
// contract: view.start-values.refuses-a-missing-section
func TestSyncRequestRefusesAViewWithoutASection(t *testing.T) {
	const view = `"id":"probe","plugin":"probe","composition":{"kind":"view","page":"ui/page.html"}`
	const missing = `surface "probe": view start section is missing`
	if err := checkViewSurface(t, `{`+view+`,"start":{"origin":{"directory":null},"diagnostics":null}}`); err == nil || err.Error() != missing {
		t.Fatalf("no section: %v, want %q", err, missing)
	}
}

// A view section is null or an object with exactly a non-empty id, a non-empty sidebar and a card that is a non-empty text or
// null; any other value is refused with its reason, and the forms of the contract are accepted.
// contract: view.start-values.refuses-a-section-of-another-form
func TestSyncRequestRefusesASectionOfAnotherForm(t *testing.T) {
	const view = `"id":"probe","plugin":"probe","composition":{"kind":"view","page":"ui/page.html"}`
	const malformed = `surface "probe": view start section is not {id, sidebar, card}`
	const start = `"origin":{"directory":null},"diagnostics":null,"process":"plugin","dialog":null,"section":`
	cases := []struct{ name, section, want string }{
		{"tab section null", `null`, ""},
		{"section object", `{"id":"probe.tree","sidebar":"left","card":null}`, ""},
		{"card sidebar section", `{"id":"probe.dom","sidebar":"c3:right","card":"c3"}`, ""},
		{"section of another type", `[]`, malformed},
		{"text section", `"spc-aaaaaa/left/probe.tree"`, malformed},
		{"missing card", `{"id":"probe.tree","sidebar":"left"}`, malformed},
		{"null id", `{"id":null,"sidebar":"left","card":null}`, malformed},
		{"empty id", `{"id":"","sidebar":"left","card":null}`, malformed},
		{"empty sidebar", `{"id":"probe.tree","sidebar":"","card":null}`, malformed},
		{"empty card", `{"id":"probe.tree","sidebar":"c3:right","card":""}`, malformed},
		{"card of another type", `{"id":"probe.tree","sidebar":"c3:right","card":3}`, malformed},
		{"another member", `{"id":"probe.tree","sidebar":"left","card":null,"name":"Files"}`, malformed},
	}
	for _, tc := range cases {
		err := checkViewSurface(t, `{`+view+`,"start":{`+start+tc.section+`}}`)
		if tc.want == "" {
			if err != nil {
				t.Fatalf("%s: %v, want accepted", tc.name, err)
			}
		} else if err == nil || err.Error() != tc.want {
			t.Fatalf("%s: %v, want %q", tc.name, err, tc.want)
		}
	}
}

// A view start whose section is an object injects it frozen into window.sokSurface, after the diagnostic declaration.
// contract: view.start-values.first-script
func TestSurfaceStartScriptInjectsTheSection(t *testing.T) {
	var start ViewStart
	if err := json.Unmarshal([]byte(`{"origin":{"directory":null},"diagnostics":null,"section":{"card":"c3","id":"probe.tree","sidebar":"c3:right"},"dialog":null}`), &start); err != nil {
		t.Fatalf("start values: %v", err)
	}
	want := `window.sokSurface = Object.freeze({"surface":"probe-surface","params":null,"origin":Object.freeze({"directory":null}),"project":null,"declarations":Object.freeze({}),"diagnostics":null,"section":Object.freeze({"card":"c3","id":"probe.tree","sidebar":"c3:right"}),"dialog":null,"levels":Object.freeze({"call":"error","frame":"error","input":"error","io":"error","lifecycle":"error"}),"dataFolder":"/data"});`
	got, err := surfaceStartScript("probe-surface", start, defaultLevels(), "/data")
	if err != nil {
		t.Fatalf("start values script: %v", err)
	}
	if got != want {
		t.Fatalf("start values script %q, want %q", got, want)
	}
}

// A view surface whose start values carry no dialog is refused with its reason. The dialog is checked after the section.
// contract: view.start-values.refuses-a-missing-dialog
func TestSyncRequestRefusesAViewWithoutADialog(t *testing.T) {
	const view = `"id":"probe","plugin":"probe","composition":{"kind":"view","page":"ui/page.html"}`
	const missing = `surface "probe": view start dialog is missing`
	if err := checkViewSurface(t, `{`+view+`,"start":{"origin":{"directory":null},"diagnostics":null,"section":null,"process":"plugin"}}`); err == nil || err.Error() != missing {
		t.Fatalf("no dialog: %v, want %q", err, missing)
	}
}

// A view dialog is null or an object with exactly a non-empty name and a non-empty opener, and a view is not a section and a dialog;
// any other value is refused with its reason, and the forms of the contract are accepted (docs/spec/plugins.md#dialogs).
// contract: view.start-values.refuses-a-dialog-of-another-form
func TestSyncRequestRefusesADialogOfAnotherForm(t *testing.T) {
	const view = `"id":"probe","plugin":"probe","composition":{"kind":"view","page":"ui/page.html"}`
	const malformed = `surface "probe": view start dialog is not {name, opener}`
	const start = `"origin":{"directory":null},"diagnostics":null,"process":"plugin","section":null,"dialog":`
	cases := []struct{ name, dialog, want string }{
		{"dialog null", `null`, ""},
		{"dialog object", `{"name":"edit","opener":"tab-a"}`, ""},
		{"dialog of another type", `[]`, malformed},
		{"text dialog", `"edit"`, malformed},
		{"missing opener", `{"name":"edit"}`, malformed},
		{"empty name", `{"name":"","opener":"tab-a"}`, malformed},
		{"empty opener", `{"name":"edit","opener":""}`, malformed},
		{"name of another type", `{"name":3,"opener":"tab-a"}`, malformed},
		{"another member", `{"name":"edit","opener":"tab-a","title":"Edit"}`, malformed},
	}
	for _, tc := range cases {
		err := checkViewSurface(t, `{`+view+`,"start":{`+start+tc.dialog+`}}`)
		if tc.want == "" {
			if err != nil {
				t.Fatalf("%s: %v, want accepted", tc.name, err)
			}
		} else if err == nil || err.Error() != tc.want {
			t.Fatalf("%s: %v, want %q", tc.name, err, tc.want)
		}
	}
	both := `"origin":{"directory":null},"diagnostics":null,"process":"plugin","section":{"id":"probe.tree","sidebar":"left","card":null},"dialog":{"name":"edit","opener":"tab-a"}`
	const twice = `surface "probe": view start is a section and a dialog`
	if err := checkViewSurface(t, `{`+view+`,"start":{`+both+`}}`); err == nil || err.Error() != twice {
		t.Fatalf("section and dialog: %v, want %q", err, twice)
	}
}

// A view start whose dialog is an object injects it frozen into window.sokSurface, after the section.
// contract: view.start-values.first-script
func TestSurfaceStartScriptInjectsTheDialog(t *testing.T) {
	var start ViewStart
	if err := json.Unmarshal([]byte(`{"origin":{"directory":null},"diagnostics":null,"section":null,"dialog":{"name":"edit","opener":"tab-a"}}`), &start); err != nil {
		t.Fatalf("start values: %v", err)
	}
	want := `window.sokSurface = Object.freeze({"surface":"probe-surface","params":null,"origin":Object.freeze({"directory":null}),"project":null,"declarations":Object.freeze({}),"diagnostics":null,"section":null,"dialog":Object.freeze({"name":"edit","opener":"tab-a"}),"levels":Object.freeze({"call":"error","frame":"error","input":"error","io":"error","lifecycle":"error"}),"dataFolder":"/data"});`
	got, err := surfaceStartScript("probe-surface", start, defaultLevels(), "/data")
	if err != nil {
		t.Fatalf("start values script: %v", err)
	}
	if got != want {
		t.Fatalf("start values script %q, want %q", got, want)
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

// defaultLevels is the stored level of each class under the default policy, which the host writes as the start value levels.
func defaultLevels() map[string]string { return DefaultLogPolicy().Classes() }

// The start value levels is the stored level of each class of the policy in force of the host writer, which the page reads only to
// skip building data that the writer would not store (docs/spec/native-surfaces.md#view-surfaces).
// contract: view.start-values.levels
func TestSurfaceStartScriptCarriesTheStoredLevelOfEachClass(t *testing.T) {
	levels := defaultLevels()
	levels["frame"] = "debug"
	got, err := surfaceStartScript("probe-surface", nullOriginStart(), levels, "/data")
	if err != nil {
		t.Fatalf("start values script: %v", err)
	}
	want := `,"levels":Object.freeze({"call":"error","frame":"debug","input":"error","io":"error","lifecycle":"error"}),"dataFolder":"/data"});`
	if !strings.HasSuffix(got, want) {
		t.Fatalf("start values script %q, want the suffix %q", got, want)
	}
}

// contract: view.start-values.omitted-keeps-held
func TestAViewWithoutStartKeepsTheValuesThatTheHostHolds(t *testing.T) {
	s := &Surfaces{}
	held := ViewStart{Params: json.RawMessage(`{"path":"/work/held"}`)}
	s.viewRecords().track("probe", nil, "probe", "ui/page.html", true).start = held
	got, err := s.viewStartOf(Surface{ID: "probe"})
	if err != nil || string(got.Params) != string(held.Params) {
		t.Fatalf("held start values: %q, %v, want %q", got.Params, err, held.Params)
	}
	next := ViewStart{Params: json.RawMessage(`{"path":"/work/next"}`)}
	got, err = s.viewStartOf(Surface{ID: "probe", Start: &next})
	if err != nil || string(got.Params) != string(next.Params) {
		t.Fatalf("start values of the request: %q, %v, want %q", got.Params, err, next.Params)
	}
	_, err = s.viewStartOf(Surface{ID: "other"})
	if want := `surface "other": view start is missing`; err == nil || err.Error() != want {
		t.Fatalf("a view without held start values: %v, want %q", err, want)
	}
	decoded, err := decodeSyncRequest(json.RawMessage(`{"settled":true,"titlebar":40,"viewport":{"width":800,"height":600},"declarations":[],"surfaces":[{"id":"probe","visible":true,"dim":false,"plugin":"probe","composition":{"kind":"view","page":"ui/page.html"},"x":0,"y":0,"w":10,"h":10}]}`))
	if err != nil {
		t.Fatalf("a request without start values: %v", err)
	}
	if decoded.Surfaces[0].Start != nil {
		t.Fatalf("decoded start values: %+v, want none", decoded.Surfaces[0].Start)
	}
	composition := map[string]SurfaceComposition{"probe": decoded.Surfaces[0].Composition}
	if _, err := CheckSyncRequest(decoded, composition, map[string]string{"probe": "probe"}); err != nil {
		t.Fatalf("the check of a request without start values: %v", err)
	}
}

// The decoding of a sync request keeps the process of the start values of a view, which the view creation reads
// (docs/spec/plugin-processes.md#view-processes). The Rust host decodes the request of its case before the check.
// contract: view.start-values.refuses-a-process-of-another-form
func TestASyncRequestKeepsTheProcessOfAViewStart(t *testing.T) {
	request, err := decodeSyncRequest(json.RawMessage(`{"settled":true,"titlebar":40,"viewport":{"width":800,"height":600},"declarations":[{}],"surfaces":[{"id":"probe","visible":true,"dim":false,"x":0,"y":0,"w":10,"h":10,"plugin":"probe",` +
		`"composition":{"kind":"view","page":"ui/page.html"},"start":{"origin":{"directory":null},"declarations":0,` +
		`"diagnostics":null,"section":null,"dialog":null,"process":"view"}}]}`))
	if err != nil {
		t.Fatal(err)
	}
	if got := request.Surfaces[0].Start.Process; got != "view" {
		t.Fatalf("the decoded start process is %q, want view", got)
	}
}

// The start value dataFolder is the data folder of the plugin of the view, which the host creates with mode 0700 before the view
// starts (docs/spec/native-surfaces.md#view-surfaces).
// contract: view.start-values.data-folder
func TestSurfaceStartScriptCarriesTheDataFolderOfThePlugin(t *testing.T) {
	configDir := t.TempDir()
	folder, err := PluginDataFolder(configDir, "probe")
	if err != nil {
		t.Fatalf("plugin data folder: %v", err)
	}
	if want := filepath.Join(configDir, "plugin-data", "probe"); folder != want {
		t.Fatalf("plugin data folder %q, want %q", folder, want)
	}
	info, err := os.Stat(folder)
	if err != nil {
		t.Fatalf("plugin data folder: %v", err)
	}
	if !info.IsDir() || info.Mode().Perm() != 0o700 {
		t.Fatalf("plugin data folder mode %v, want a folder with mode 0700", info.Mode())
	}
	got, err := surfaceStartScript("probe-surface", nullOriginStart(), defaultLevels(), folder)
	if err != nil {
		t.Fatalf("start values script: %v", err)
	}
	want := `,"dataFolder":"` + folder + `"});`
	if !strings.HasSuffix(got, want) {
		t.Fatalf("start values script %q, want the suffix %q", got, want)
	}
	if _, err := PluginDataFolder("relative", "probe"); err == nil {
		t.Fatalf("a relative configuration directory gave a data folder")
	}
}

// contract: surfaces-geometry.sync.decode-keeps-the-settings-clip
func TestDecodedSyncRequestKeepsTheClipOfTheSettingsSurface(t *testing.T) {
	const surface = `"id":"settings/probe","visible":true,"dim":false,"plugin":"probe","composition":{"kind":"view","page":"ui/settings.html"},"x":10,"y":20,"w":300,"h":400`
	decoded, err := decodeSyncRequest(json.RawMessage(`{"settled":true,"titlebar":40,"viewport":{"width":800,"height":600},"declarations":[],"surfaces":[{` + surface + `,"clip":{"x":10,"y":30,"w":300,"h":200}}]}`))
	if err != nil {
		t.Fatalf("a settings surface with a clip: %v", err)
	}
	if got := decoded.Surfaces[0].Clip; got == nil || *got != (Rect{X: 10, Y: 30, W: 300, H: 200}) {
		t.Fatalf("decoded clip %+v, want {10 30 300 200}", got)
	}
}

// A window without a main page draws its settings window itself and holds the settings surface in the native view element of the seat,
// which the pane clips, so the host seats the settings surface over a modal web view only in a window with a main page
// (docs/spec/native-modals.md#settings-surface, F1200).
// contract: surfaces-geometry.sync.settings-seat-over-modal-needs-a-main-page
func TestOnlyAWindowWithAMainPageSeatsTheSettingsSurfaceOverItsModal(t *testing.T) {
	previous := framework
	t.Cleanup(func() { framework = previous })
	framework = pagelessFramework{}
	if seatsOverModal("settings/probe") || seatsOverModal("tab-1") {
		t.Fatal("a window without a main page seats a surface over a modal web view")
	}
	framework = mainThreadFramework{}
	if !seatsOverModal("settings/probe") || seatsOverModal("tab-1") {
		t.Fatal("a window with a main page does not seat only the settings surface over its modal web view")
	}
}

// A window without a main page shows the surfaces below its settings window in the holes that it draws, so only its settings surface
// host fills itself with the background of the window, the color of the pane; a window with a main page seats the settings surface over
// its modal web view, which draws the pane below it (docs/spec/native-surfaces.md#settings-seat, F1206).
// contract: surfaces-geometry.sync.settings-surface-fills-the-window-background
func TestOnlyTheSettingsSurfaceOfAWindowWithoutAMainPageFillsTheWindowBackground(t *testing.T) {
	previous := framework
	t.Cleanup(func() { framework = previous })
	framework = pagelessFramework{}
	if !fillsWindowBackground("settings/probe") || fillsWindowBackground("tab-1") {
		t.Fatal("a window without a main page does not fill only its settings surface with the window background")
	}
	framework = mainThreadFramework{}
	if fillsWindowBackground("settings/probe") || fillsWindowBackground("tab-1") {
		t.Fatal("a window with a main page fills a surface with the window background")
	}
}
