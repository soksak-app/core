package workbench_test

import (
	"context"
	"encoding/json"
	"strings"
	"testing"

	"github.com/egoist/mygo/ui"

	workbench "github.com/soksak-app/core/packages/workbench-mygo/src"
)

// installedDocument is the document of the installed plugins with one plugin of a view and one without a surface.
const installedDocument = `{"plugins": [
	{"id": "terminal", "package": "@soksak/plugin-terminal", "version": "1.0.0", "sidecars": {"@soksak/sidecar-vt": {}},
		"manifest": {"id": "terminal", "name": "터미널", "mark": "◊",
			"dependencies": {"@soksak/sidecar-vt": "^1.0.0"},
			"exposes": {"commands": [{"name": "terminal.drop"}]},
			"data": {"notes": {"schema": {"type": "string"}, "default": "none", "format": 2},
				"marks": {"schema": {"type": "array", "items": {"type": "string"}}, "default": ["start"]}},
			"settings": {"cursor.shape": {"type": "enum", "default": "block", "values": ["block", "beam"]}, "shell": {"type": "text", "default": ""}},
			"surface": {"drop": "terminal.drop", "composition": {"kind": "view", "page": "ui/terminal.html", "regions": [{"name": "view", "kind": "image"}]}}}},
	{"id": "browser", "package": "@soksak/plugin-browser", "version": "1.0.0",
		"diagnostics": {"module": "ui/diagnostics.js", "exposes": {"status": [{"name": "plugin.browser.probe"}]}},
		"manifest": {"id": "browser", "name": "브라우저", "mark": "www",
			"surface": {"composition": {"kind": "view", "page": "ui/index.html"}}}}
]}`

// surfaceHost records the surface calls of the workbench.
type surfaceHost struct {
	storedHost
	requests []map[string]any
	placed   int
	declared []string
	replies  []map[string]any
	hostName []string
	// theme is the argument of setTheme, and themeFirst tells that no placement preceded it.
	theme      string
	themeFirst bool
	// elements tells that the host holds the views of the surfaces.
	elements bool
}

func (h *surfaceHost) surfaceTable() map[string]workbench.HostCall {
	table := h.table()
	table["syncSurfaces"] = func(_ context.Context, argument json.RawMessage) (any, error) {
		var request map[string]any
		if err := json.Unmarshal(argument, &request); err != nil {
			return nil, err
		}
		h.requests = append(h.requests, request)
		return map[string]any{"ticket": len(h.requests), "placements": []any{}, "chrome": map[string]any{}}, nil
	}
	table["presentSurfaces"] = func(context.Context, json.RawMessage) (any, error) {
		h.placed++
		return []any{}, nil
	}
	table["compositionDeclare"] = func(_ context.Context, argument json.RawMessage) (any, error) {
		var request struct{ Surface string }
		if err := json.Unmarshal(argument, &request); err != nil {
			return nil, err
		}
		h.declared = append(h.declared, request.Surface)
		return nil, nil
	}
	table["setTheme"] = func(_ context.Context, argument json.RawMessage) (any, error) {
		h.theme = string(argument)
		h.themeFirst = len(h.requests) == 0
		return nil, nil
	}
	table["viewReply"] = func(_ context.Context, argument json.RawMessage) (any, error) {
		var reply map[string]any
		if err := json.Unmarshal(argument, &reply); err != nil {
			return nil, err
		}
		h.replies = append(h.replies, reply)
		return nil, nil
	}
	for _, name := range []string{"viewSidecarRoute", "sidecarListen", "viewEvent", "compositionPlace", "imageAttach", "sidecarSend", "exposureRegister", "viewRequest", "notify", "notificationRemove"} {
		table[name] = func(_ context.Context, argument json.RawMessage) (any, error) {
			h.hostName = append(h.hostName, name+" "+string(argument))
			return nil, nil
		}
	}
	return table
}

// element returns the views of a surface once the host holds them.
func (h *surfaceHost) element(id string) (uintptr, uintptr, bool) {
	if !h.elements {
		return 0, 0, false
	}
	return 1, 2, true
}

// surfaceShell opens a project in a shell with the plugins of installedDocument.
func surfaceShell(t *testing.T) (*shellFixture, *surfaceHost) {
	t.Helper()
	return surfaceShellOf(t, installedDocument)
}

// surfaceShellOf opens a project in a shell with the plugins of document.
func surfaceShellOf(t *testing.T, document string) (*shellFixture, *surfaceHost) {
	t.Helper()
	declared, err := workbench.Declared()
	if err != nil {
		t.Fatal(err)
	}
	stored := &surfaceHost{}
	f := &shellFixture{t: t, host: &stored.storedHost, pending: make(steps, 256)}
	shell, err := workbench.NewShell(workbench.ShellOptions{
		Declared:    declared,
		Calls:       workbench.NewCalls(stored.surfaceTable(), f.pending.post),
		Environment: environment(t),
		Installed:   []byte(document),
		Invalidate:  func() {},
		Post:        f.pending.post,
		Report:      func(line string) { f.lines = append(f.lines, line) },
		Element:     func(id string) (uintptr, uintptr, bool) { return stored.element(id) },
	})
	if err != nil {
		t.Fatal(err)
	}
	f.shell = shell
	f.tester = ui.NewTester(shell.View, 1200, 800)
	shell.Start()
	f.settle()
	f.run("core.library.form.open", map[string]string{"mode": "open"})
	f.run("core.library.form.set", map[string]string{"field": "parent", "value": "/work/alpha"})
	f.run("core.library.form.submit", nil)
	return f, stored
}

// lastSurfaces returns the surfaces of the last request by id.
func (h *surfaceHost) lastSurfaces(t *testing.T) map[string]map[string]any {
	t.Helper()
	if len(h.requests) == 0 {
		t.Fatal("the workbench placed no surface")
	}
	surfaces := map[string]map[string]any{}
	for _, item := range h.requests[len(h.requests)-1]["surfaces"].([]any) {
		surface := item.(map[string]any)
		surfaces[surface["id"].(string)] = surface
	}
	return surfaces
}

func TestCardsPlaceTheViewsOfTheirActiveTabs(t *testing.T) {
	f, stored := surfaceShell(t)
	surfaces := stored.lastSurfaces(t)
	if len(surfaces) != len(f.tabbedCards()) {
		t.Fatalf("the request holds %d surfaces for %d cards", len(surfaces), len(f.tabbedCards()))
	}
	if stored.placed != len(stored.requests) {
		t.Fatalf("%d of %d requests were presented", stored.placed, len(stored.requests))
	}
	if len(stored.declared) != len(surfaces) {
		t.Fatalf("declared %v", stored.declared)
	}
	declarations := stored.requests[0]["declarations"].([]any)
	for id, surface := range surfaces {
		if surface["visible"] != true || surface["w"].(float64) <= 0 || surface["h"].(float64) <= 0 {
			t.Fatalf("surface %s is %v", id, surface)
		}
		if surface["composition"].(map[string]any)["kind"] != "view" {
			t.Fatalf("surface %s has the composition %v", id, surface["composition"])
		}
		start, ok := surface["start"].(map[string]any)
		if len(stored.requests) == 1 && !ok {
			t.Fatalf("surface %s has no start values", id)
		}
		if ok {
			if start["project"].(map[string]any)["root"] != "/work/alpha" || int(start["declarations"].(float64)) >= len(declarations) {
				t.Fatalf("surface %s starts with %v", id, start)
			}
		}
	}
	before := len(stored.requests)
	f.settle()
	if len(stored.requests) != before {
		t.Fatal("a frame without a change sent a placement")
	}
}

// A card draws the native view element of its surface in its slot, in the frame after the host made the surface: the element paints a
// hole over the card, and the framework places the surface host there.
func TestACardDrawsTheNativeViewElementOfItsSurface(t *testing.T) {
	f, stored := surfaceShell(t)
	var surface map[string]any
	for _, candidate := range stored.lastSurfaces(t) {
		surface = candidate
	}
	x, y := int(surface["x"].(float64)+surface["w"].(float64)/2), int(surface["y"].(float64)+surface["h"].(float64)/2)
	if f.tester.Image().RGBAAt(x, y).A == 0 {
		t.Fatal("the slot has a hole before the host made the surface")
	}
	stored.elements = true
	f.settle()
	if f.tester.Image().RGBAAt(x, y).A != 0 {
		t.Fatalf("the slot of the card at %d, %d shows no native view element", x, y)
	}
}

func TestTheThemeOfTheViewsPrecedesTheirPlacement(t *testing.T) {
	_, stored := surfaceShell(t)
	var theme struct {
		Scheme string            `json:"scheme"`
		Tokens map[string]string `json:"tokens"`
	}
	if err := json.Unmarshal([]byte(stored.theme), &theme); err != nil {
		t.Fatalf("setTheme took %q: %v", stored.theme, err)
	}
	if !stored.themeFirst || theme.Scheme != "dark" || theme.Tokens["--bg"] == "" || theme.Tokens["--font"] == "" || theme.Tokens["--half-gap"] != "6px" {
		t.Fatalf("the first placement %v met the theme %+v", stored.themeFirst, theme)
	}
}

func TestSplitPlacesTheViewOfTheNewCard(t *testing.T) {
	f, stored := surfaceShell(t)
	before := len(stored.lastSurfaces(t))
	f.run("core.card.split", map[string]string{"card": f.tabbedCards()[0], "side": "right"})
	if got := len(stored.lastSurfaces(t)); got != before+1 {
		t.Fatalf("the split placed %d surfaces after %d", got, before)
	}
	f.click("core.card.close", f.tabbedCards()[len(f.tabbedCards())-1])
	if got := len(stored.lastSurfaces(t)); got != before {
		t.Fatalf("the close placed %d surfaces, want %d", got, before)
	}
}

func TestLibraryHidesTheViews(t *testing.T) {
	f, stored := surfaceShell(t)
	f.run("core.projects.browse", nil)
	for id, surface := range stored.lastSurfaces(t) {
		if surface["visible"] != false {
			t.Fatalf("surface %s stays visible over the library", id)
		}
	}
}

// viewCall delivers a call of the view of the tab and returns its reply.
func viewCall(t *testing.T, f *shellFixture, stored *surfaceHost, surface, command string, params any) map[string]any {
	t.Helper()
	f.shell.Event("view-call", []any{map[string]any{"surface": surface, "plugin": "terminal", "generation": 1, "id": 5, "command": command, "params": params}})
	f.settle()
	if len(stored.replies) == 0 {
		t.Fatalf("view call %s has no reply", command)
	}
	reply := stored.replies[len(stored.replies)-1]
	if reply["surface"] != surface || reply["generation"] != float64(1) || reply["id"] != float64(5) || reply["page"] == "" {
		t.Fatalf("the reply is %v", reply)
	}
	return reply
}

func anySurface(t *testing.T, stored *surfaceHost) string {
	t.Helper()
	for id := range stored.lastSurfaces(t) {
		return id
	}
	t.Fatal("no surface")
	return ""
}

// A diagnostic build lists diagnostics.json in the installed plugins document: its declarations add to those of the surface, and the
// view page reads the diagnostic module from its start values.
func TestADiagnosticPluginAddsItsDeclarationsToTheSurface(t *testing.T) {
	_, stored := surfaceShell(t)
	request := stored.requests[0]
	declarations := request["declarations"].([]any)
	found := false
	for _, item := range request["surfaces"].([]any) {
		surface := item.(map[string]any)
		start := surface["start"].(map[string]any)
		declared, _ := json.Marshal(declarations[int(start["declarations"].(float64))])
		if surface["plugin"] != "browser" {
			if start["diagnostics"] != nil || strings.Contains(string(declared), "plugin.browser.probe") {
				t.Fatalf("surface %v starts with %v and %s", surface["id"], start, declared)
			}
			continue
		}
		found = true
		if start["diagnostics"].(map[string]any)["module"] != "ui/diagnostics.js" || !strings.Contains(string(declared), "plugin.browser.probe") {
			t.Fatalf("the view starts with %v and %s", start, declared)
		}
	}
	if !found {
		t.Fatal("no surface of the browser plugin")
	}
}

func TestViewCallDeclaresItsComposition(t *testing.T) {
	f, stored := surfaceShell(t)
	reply := viewCall(t, f, stored, anySurface(t, stored), "composition.declaration", nil)
	result, ok := reply["result"].(map[string]any)
	if !ok || result["kind"] != "view" {
		t.Fatalf("the reply is %v", reply)
	}
}

func TestViewCallTitleNamesTheTab(t *testing.T) {
	f, stored := surfaceShell(t)
	viewCall(t, f, stored, anySurface(t, stored), "tab.title", "zsh in alpha")
	if !f.tester.HasText("zsh in alpha") {
		t.Fatalf("the tabs show %q", f.tester.Texts())
	}
}

func TestViewCallReadsTheSettingsOfThePlugin(t *testing.T) {
	f, stored := surfaceShell(t)
	reply := viewCall(t, f, stored, anySurface(t, stored), "runtime.settings.read", nil)
	result := reply["result"].(map[string]any)
	if result["cursor.shape"] != "block" {
		t.Fatalf("the settings are %v", result)
	}
}

func TestViewCallOfAnUnservedCommandFails(t *testing.T) {
	f, stored := surfaceShell(t)
	reply := viewCall(t, f, stored, anySurface(t, stored), "runtime.nothing", nil)
	if reply["error"] == nil {
		t.Fatalf("the reply is %v", reply)
	}
}

func TestViewCallSubscribesItsSidecar(t *testing.T) {
	f, stored := surfaceShell(t)
	surface := anySurface(t, stored)
	reply := viewCall(t, f, stored, surface, "runtime.sidecar.on", map[string]any{"id": surface, "sidecar": "@soksak/sidecar-vt"})
	if reply["error"] != nil {
		t.Fatalf("the reply is %v", reply)
	}
	if len(stored.hostName) == 0 {
		t.Fatal("the subscription reached no host call")
	}
}

func TestViewCallReadsTheTextScaleOfItsCard(t *testing.T) {
	f, stored := surfaceShell(t)
	reply := viewCall(t, f, stored, anySurface(t, stored), "runtime.textSize.read", nil)
	if reply["error"] != nil || reply["result"] != float64(1) {
		t.Fatalf("the reply is %v", reply)
	}
	if reply := viewCall(t, f, stored, anySurface(t, stored), "runtime.textSize.on", nil); reply["error"] != nil {
		t.Fatalf("the reply is %v", reply)
	}
}

func TestViewCallRegistersOnlyADeclaredCommand(t *testing.T) {
	f, stored := surfaceShell(t)
	surface := anySurface(t, stored)
	if reply := viewCall(t, f, stored, surface, "runtime.command.register", map[string]any{"name": "other.thing"}); reply["error"] == nil {
		t.Fatalf("the reply is %v", reply)
	}
}

func TestViewCallFollowsAStatusOfTheWorkbench(t *testing.T) {
	f, stored := surfaceShell(t)
	surface := anySurface(t, stored)
	if reply := viewCall(t, f, stored, surface, "runtime.status.watch", map[string]any{"name": "core.sidebars"}); reply["error"] != nil {
		t.Fatalf("the reply is %v", reply)
	}
	if reply := viewCall(t, f, stored, surface, "runtime.status.watch", map[string]any{"name": "core.nothing"}); reply["error"] == nil {
		t.Fatalf("the reply is %v", reply)
	}
	if reply := viewCall(t, f, stored, surface, "runtime.status.unwatch", map[string]any{"name": "core.sidebars"}); reply["error"] != nil {
		t.Fatalf("the reply is %v", reply)
	}
}

func TestViewCallReportsItsFocus(t *testing.T) {
	f, stored := surfaceShell(t)
	surface := anySurface(t, stored)
	if reply := viewCall(t, f, stored, surface, "tab.focus", map[string]any{"name": "browser.address", "index": 0}); reply["error"] != nil {
		t.Fatalf("the reply is %v", reply)
	}
	if reply := viewCall(t, f, stored, surface, "tab.focus", map[string]any{"name": ""}); reply["error"] == nil {
		t.Fatalf("the reply is %v", reply)
	}
}
