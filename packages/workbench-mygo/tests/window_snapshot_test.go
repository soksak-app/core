// The window snapshot exposure.snapshot of the workbench (docs/spec/exposure.md#window-snapshot), as the test "a window snapshot holds the
// layout, the plugins, the group of the main document, one group per surface and the unregistered entries" of
// packages/workbench/test/exposure.test.mjs states it for the page.
package workbench_test

import (
	"encoding/json"
	"reflect"
	"sort"
	"strings"
	"testing"

	"github.com/egoist/mygo/ui"

	workbench "github.com/soksak-app/core/packages/workbench-mygo/src"
)

// declarationOf is the declaration of name in the exposure.list of the relay, without registered.
func declarationOf(t *testing.T, r *relay, key, name string) map[string]any {
	t.Helper()
	list := r.ask("exposure.list", `{}`)["result"].(map[string]any)
	for _, entry := range list[key].([]any) {
		row := entry.(map[string]any)
		if row["name"] == name {
			delete(row, "registered")
			return row
		}
	}
	t.Fatalf("exposure.list has no %s %s", key, name)
	return nil
}

// unregisteredOf are the entries of the exposure.list of the relay that no owner registered, as the snapshot lists them.
func unregisteredOf(r *relay) []any {
	list := r.ask("exposure.list", `{}`)["result"].(map[string]any)
	entries := []any{}
	for _, pair := range [][2]string{{"status", "status"}, {"commands", "command"}, {"element", "element"}} {
		for _, entry := range list[pair[0]].([]any) {
			if row := entry.(map[string]any); row["registered"] == false {
				entries = append(entries, map[string]any{"kind": pair[1], "name": row["name"]})
			}
		}
	}
	return entries
}

// entryNames are the entries as "<kind> <name>", each once, in text order.
func entryNames(entries []string) []string {
	seen := map[string]bool{}
	names := []string{}
	for _, entry := range entries {
		if !seen[entry] {
			seen[entry] = true
			names = append(names, entry)
		}
	}
	sort.Strings(names)
	return names
}

// listedNames are the entries of the exposure.list of the relay.
func listedNames(r *relay) []string {
	list := r.ask("exposure.list", `{}`)["result"].(map[string]any)
	entries := []string{}
	for _, pair := range [][2]string{{"status", "status"}, {"commands", "command"}, {"element", "element"}} {
		for _, entry := range list[pair[0]].([]any) {
			entries = append(entries, pair[1]+" "+entry.(map[string]any)["name"].(string))
		}
	}
	return entryNames(entries)
}

// snapshotNames are the entries of the groups and the unregistered entries of a snapshot.
func snapshotNames(result map[string]any) []string {
	entries := []string{}
	for _, group := range result["groups"].([]any) {
		read := group.(map[string]any)
		for _, pair := range [][2]string{{"status", "status"}, {"commands", "command"}, {"element", "element"}} {
			for _, entry := range read[pair[0]].([]any) {
				entries = append(entries, pair[1]+" "+entry.(map[string]any)["name"].(string))
			}
		}
	}
	for _, entry := range result["unregistered"].([]any) {
		read := entry.(map[string]any)
		entries = append(entries, read["kind"].(string)+" "+read["name"].(string))
	}
	return entryNames(entries)
}

// asJSON is value as the host receives it.
func asJSON(t *testing.T, value any) any {
	t.Helper()
	text, err := json.Marshal(value)
	if err != nil {
		t.Fatal(err)
	}
	var read any
	if err := json.Unmarshal([]byte(text), &read); err != nil {
		t.Fatal(err)
	}
	return read
}

// contract: endpoint.exposure-snapshot.groups-the-window, endpoint.exposure-snapshot.surface-parts
func TestAWindowSnapshotHoldsTheLayoutThePluginsTheMainGroupTheSurfaceGroupsAndTheUnregisteredEntries(t *testing.T) {
	f := newSurfaceRequests(t)
	f.plugins["tab-d"] = "textprobe"
	layout := map[string]any{"space": "spc-a", "focused": "main", "root": map[string]any{"card": "main", "size": 1,
		"frame": map[string]any{"x": 0, "y": 0, "width": 800, "height": 600}, "tabs": []any{}}}
	plugins := []workbench.PluginDescription{{Plugin: "textprobe", Name: "Probe", Description: "Probe.",
		Surface: &workbench.PluginSurface{Params: nil, Opens: []string{}}}}
	surfaces := []workbench.SnapshotSurface{
		{Surface: "tab-a", Plugin: "textprobe", Kind: "tab", State: "loaded", Visible: true},
		{Surface: "tab-b", Plugin: "textprobe", Kind: "tab", State: "loaded", Visible: false},
		{Surface: "tab-c", Plugin: "boxprobe", Kind: "tab", State: "unloaded", Visible: false},
		{Surface: "tab-d", Plugin: "textprobe", Kind: "tab", State: "loaded", Visible: false},
	}
	f.registry.SnapshotPartsOf(func() (workbench.SnapshotParts, error) {
		return workbench.SnapshotParts{Layout: layout, Plugins: plugins, Surfaces: surfaces}, nil
	})
	// The open dialog holds the surface documents behind it; the elements of the main document stand in front of it here.
	f.frames["tab-a"] = [2]float64{100, 50}
	f.behind = true
	f.registry.Status("core.layout", func() any { return 3 })
	f.registry.Status("core.grid", func() any { return make(chan int) })
	f.registry.Command("core.card.focus", func(json.RawMessage) (any, error) { return nil, nil })
	f.registry.Command("core.card.tools", func(json.RawMessage) (any, error) { return nil, nil })
	binder := workbench.NewBinder(f.registry, func(_ string, err error) { t.Error(err) })
	tester := ui.NewTester(func(c *ui.Context) {
		binder.Frame()
		ui.Column(c).Fill().Children(func() {
			// The label names the card for assistive technology; the text of the item is the text content, the texts inside it.
			binder.Press(c, "core.card", "core.card.focus", "c1", map[string]string{"card": "c1"}).Role(ui.RoleGroup).Label("c1").Size(100, 40).
				Children(func() { ui.Text(c, "first   \n card") })
			binder.Absent(c, "core.card", "core.card.focus", "c2", map[string]string{"card": "c2"})
			binder.Absent(c, "core.card.tools", "core.card.tools", "c1", map[string]string{"card": "c1"})
			ui.Button(c.Key(workbench.Exposed{Name: "core.debug.close"}), strings.Repeat("가", 130)).Size(60, 20)
		})
	}, 400, 300)
	f.registry.Elements(drawnElements{tester})
	for _, surface := range []string{"tab-a", "tab-b"} {
		f.register(surface, "status", "textprobe.screen")
		f.register(surface, "element", "textprobe.view")
	}
	f.reply = func(request map[string]any) (any, error) {
		if request["surface"] == "tab-b" {
			return map[string]any{"error": map[string]any{"code": workbench.Gone, "message": "the document of surface tab-b ended"}}, nil
		}
		return map[string]any{"result": map[string]any{
			"status":   []any{map[string]any{"name": "textprobe.screen", "value": []any{"x"}}},
			"commands": []any{},
			"element": []any{map[string]any{"name": "textprobe.view", "items": []any{map[string]any{"index": 0, "role": nil, "text": "x",
				"rect": map[string]any{"x": 12, "y": 24, "width": 80, "height": 30}, "command": nil, "params": nil}}}},
		}}, nil
	}

	reply := f.ask("exposure.snapshot", `{"window": "main"}`)
	result, ok := reply["result"].(map[string]any)
	if !ok {
		t.Fatalf("the snapshot answered %v", reply)
	}
	if !reflect.DeepEqual(result["layout"], asJSON(t, layout)) || !reflect.DeepEqual(result["plugins"], asJSON(t, plugins)) {
		t.Fatalf("the snapshot holds the layout %v and the plugins %v", result["layout"], result["plugins"])
	}
	groups := result["groups"].([]any)
	main := groups[0].(map[string]any)
	layoutRow := declarationOf(t, f.relay, "status", "core.layout")
	layoutRow["value"] = float64(3)
	gridRow := declarationOf(t, f.relay, "status", "core.grid")
	gridRow["error"] = "status core.grid value: json: unsupported type: chan int"
	if want := []any{gridRow, layoutRow}; main["owner"] != "core" || !reflect.DeepEqual(main["status"], orderedAs(t, f.relay, "status", want)) {
		t.Fatalf("the main group holds the statuses %v, want %v", main["status"], want)
	}
	if want := orderedAs(t, f.relay, "commands", []any{declarationOf(t, f.relay, "commands", "core.card.focus"),
		declarationOf(t, f.relay, "commands", "core.card.tools")}); !reflect.DeepEqual(main["commands"], want) {
		t.Fatalf("the main group holds the commands %v, want %v", main["commands"], want)
	}
	type item struct {
		name, text, command string
		index               float64
		inert               bool
		params              any
	}
	var items []item
	counts := map[string]int{}
	for _, entry := range main["element"].([]any) {
		row := entry.(map[string]any)
		counts[row["name"].(string)] = len(row["items"].([]any))
		for _, each := range row["items"].([]any) {
			read := each.(map[string]any)
			if _, ok := read["visible"]; ok {
				t.Fatalf("the item %v of %s holds visible, which an item of drawn elements does not carry", read, row["name"])
			}
			command, _ := read["command"].(string)
			items = append(items, item{name: row["name"].(string), text: read["text"].(string), command: command, index: read["index"].(float64),
				inert: read["inert"].(bool), params: read["params"]})
		}
	}
	// The card c2 and the tools of c1 are not drawn: they keep their element.rect index and leave the items, and the name of the tools
	// stays as an entry with no item, since its owner registered it (docs/spec/exposure.md#window-snapshot).
	want := []item{
		{name: "core.card", text: "first card", command: "core.card.focus", index: 0, params: map[string]any{"card": "c1"}},
		{name: "core.debug.close", text: strings.Repeat("가", 120), index: 0},
	}
	if !reflect.DeepEqual(items, want) {
		t.Fatalf("the main group holds the items %+v, want %+v", items, want)
	}
	if count, ok := counts["core.card.tools"]; !ok || count != 0 {
		t.Fatalf("the main group holds the entries with item counts %v, want core.card.tools with no item", counts)
	}
	wantSurfaces := []any{
		map[string]any{"owner": "surface", "surface": "tab-a", "plugin": "textprobe", "kind": "tab", "state": "loaded", "visible": true,
			"status": []any{map[string]any{"name": "textprobe.screen", "value": []any{"x"}}}, "commands": []any{},
			"element": []any{map[string]any{"name": "textprobe.view", "items": []any{map[string]any{"index": float64(0), "role": nil, "text": "x",
				"rect":  map[string]any{"x": float64(112), "y": float64(74), "width": float64(80), "height": float64(30)},
				"inert": true, "command": nil, "params": nil}}}}},
		map[string]any{"owner": "surface", "surface": "tab-b", "plugin": "textprobe", "kind": "tab", "state": "loaded", "visible": false,
			"error": float64(workbench.Gone), "status": []any{}, "commands": []any{}, "element": []any{}},
		map[string]any{"owner": "surface", "surface": "tab-c", "plugin": "boxprobe", "kind": "tab", "state": "unloaded", "visible": false,
			"status": []any{}, "commands": []any{}, "element": []any{}},
		map[string]any{"owner": "surface", "surface": "tab-d", "plugin": "textprobe", "kind": "tab", "state": "loaded", "visible": false,
			"status": []any{}, "commands": []any{}, "element": []any{}},
	}
	if !reflect.DeepEqual(groups[1:], wantSurfaces) {
		t.Fatalf("the surface groups are %v, want %v", groups[1:], wantSurfaces)
	}
	if got, want := result["unregistered"], unregisteredOf(f.relay); !reflect.DeepEqual(got, want) {
		t.Fatalf("the unregistered entries are %v, want %v", got, want)
	}
	// The groups and the unregistered entries hold exactly the entries of exposure.list of the window.
	if got, want := snapshotNames(result), listedNames(f.relay); !reflect.DeepEqual(got, want) {
		t.Fatalf("the snapshot holds the entries %v, exposure.list %v", got, want)
	}
	if forwards := len(f.forwards); forwards != 2 {
		t.Fatalf("the snapshot forwarded %d requests, want one to tab-a and one to tab-b: %v", forwards, f.forwards)
	}

	// With surface, the groups hold only the group of that surface.
	only := f.ask("exposure.snapshot", `{"window": "main", "surface": "tab-a"}`)["result"].(map[string]any)
	if groups := only["groups"].([]any); len(groups) != 1 || groups[0].(map[string]any)["surface"] != "tab-a" ||
		!reflect.DeepEqual(only["unregistered"], []any{}) {
		t.Fatalf("the snapshot of tab-a is %v", only)
	}
	for _, refused := range []struct{ params, message string }{
		{`{"surface": "tab-z"}`, "surface tab-z is not a surface of this window"},
		{`{"surface": 5}`, "surface must be a string"},
		{`[]`, "exposure.snapshot params must be an object"},
	} {
		if code, message := f.refused(f.ask("exposure.snapshot", refused.params)); code != workbench.InvalidParams || message != refused.message {
			t.Fatalf("%s was refused with %d %q, want %q", refused.params, code, message, refused.message)
		}
	}
}

// orderedAs orders the entries of key in the order of exposure.list, the order of the declarations.
func orderedAs(t *testing.T, r *relay, key string, entries []any) []any {
	t.Helper()
	list := r.ask("exposure.list", `{}`)["result"].(map[string]any)
	ordered := []any{}
	for _, declared := range list[key].([]any) {
		for _, entry := range entries {
			if entry.(map[string]any)["name"] == declared.(map[string]any)["name"] {
				ordered = append(ordered, entry)
			}
		}
	}
	return ordered
}

// The snapshot of a window holds the layout of its description, its loaded plugins with their surface params and opens, and a group per
// surface of core.surfaces.
// contract: endpoint.exposure-snapshot.groups-the-window
func TestTheSnapshotOfAWindowHoldsItsLayoutItsPluginsAndItsSurfaces(t *testing.T) {
	f := layoutShell(t, oneCard(paramTab("t1", "notes", map[string]any{"path": "a.md"}), tab("t2", "plain")))
	var result map[string]any
	f.shell.Registry().Reply("exposure.snapshot", json.RawMessage(`{"window": "main"}`), nil, func(value any, err error) {
		if err != nil {
			t.Fatal(err)
		}
		result = asJSON(t, value).(map[string]any)
	})
	if result == nil {
		t.Fatal("the snapshot did not answer")
	}
	var described any
	if err := json.Unmarshal([]byte(f.described()), &described); err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(result["layout"], described) {
		t.Fatalf("the snapshot holds the layout %v, the description %v", result["layout"], described)
	}
	plugins := []any{
		map[string]any{"plugin": "fieldprobe", "name": "파일", "description": "fieldprobe", "surface": nil},
		map[string]any{"plugin": "notes", "name": "노트", "description": "notes", "surface": map[string]any{
			"params": map[string]any{"type": "object", "properties": map[string]any{"path": map[string]any{"type": "string"}, "line": map[string]any{"type": "number"}}},
			"opens":  []any{}}},
		map[string]any{"plugin": "plain", "name": "Plain", "description": "plain", "surface": map[string]any{"params": nil, "opens": []any{}}},
	}
	if !reflect.DeepEqual(result["plugins"], plugins) {
		t.Fatalf("the snapshot holds the plugins %v, want %v", result["plugins"], plugins)
	}
	var surfaces []string
	for _, group := range result["groups"].([]any)[1:] {
		read := group.(map[string]any)
		surfaces = append(surfaces, read["surface"].(string)+" "+read["plugin"].(string)+" "+read["state"].(string))
	}
	if want := []string{"spc-aaaaaa/left/fieldprobe.tree fieldprobe loaded", "spc-aaaaaa/left/fieldprobe.bookmarks fieldprobe loaded",
		"t1 notes loaded", "t2 plain loaded"}; !reflect.DeepEqual(surfaces, want) {
		t.Fatalf("the snapshot holds the surface groups %v, want %v", surfaces, want)
	}
}

// The text of an item is cut to its first 120 Unicode scalar values, so a character outside the Basic Multilingual Plane counts once
// and no cut splits a character.
func TestTheTextOfASnapshotItemIsCutTo120Characters(t *testing.T) {
	declared := registry(t)
	label := "a " + strings.Repeat("😀", 130)
	tester := ui.NewTester(func(c *ui.Context) {
		ui.Button(c.Key(workbench.Exposed{Name: "core.debug.close"}), label).Size(60, 20)
	}, 400, 300)
	declared.Elements(drawnElements{tester})
	r := newRelay(t, declared)
	result := r.ask("exposure.snapshot", `{}`)["result"].(map[string]any)
	main := result["groups"].([]any)[0].(map[string]any)
	var text string
	for _, entry := range main["element"].([]any) {
		if row := entry.(map[string]any); row["name"] == "core.debug.close" {
			text = row["items"].([]any)[0].(map[string]any)["text"].(string)
		}
	}
	if want := "a " + strings.Repeat("😀", 118); text != want {
		t.Fatalf("the text is %d characters %q, want %d", len([]rune(text)), text, len([]rune(want)))
	}
}
