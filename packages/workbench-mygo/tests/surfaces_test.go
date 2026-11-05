package workbench_test

import (
	"context"
	"encoding/json"
	"fmt"
	"math"
	"slices"
	"strings"
	"testing"

	"github.com/egoist/mygo/ui"

	workbench "github.com/soksak-app/core/packages/workbench-mygo/src"
)

// installedDocument is the document of the installed plugins with one plugin of a view and one without a surface.
const installedDocument = `{"plugins": [
	{"id": "terminal", "package": "@scope/plugin-terminal", "version": "1.0.0", "sidecars": {"@scope/sidecar-vt": {}},
		"manifest": {"id": "terminal", "name": "터미널", "description": "terminal", "mark": "◊", "icon": "<path d=\"M1 1h14\"/>",
			"dependencies": {"@scope/sidecar-vt": "^1.0.0"},
			"exposes": {"status": [{"name": "terminal.screen", "description": "the screen", "schema": {"type": "object", "properties": {}}}], "commands": [{"name": "terminal.drop", "description": "does it", "params": {"type": "object", "properties": {}}, "result": {"type": "null"}}, {"name": "terminal.input", "description": "does it", "params": {"type": "object", "properties": {}}, "result": {"type": "null"}}, {"name": "terminal.close", "description": "does it", "params": {"type": "object", "properties": {}}, "result": {"type": "null"}, "timeout": 40}]},
			"data": {"notes": {"schema": {"type": "string"}, "default": "none", "format": 2},
				"marks": {"schema": {"type": "array", "items": {"type": "string"}}, "default": ["start"]}},
			"settings": {"cursor.shape": {"type": "enum", "label": "모양", "default": "block", "values": ["block", "beam"]}, "shell": {"type": "string", "label": "셸", "default": "login", "maxLength": 64}},
			"surface": {"menu": [{"title": "닫기", "command": "terminal.close"}], "drop": "terminal.drop", "composition": {"kind": "view", "page": "ui/terminal.html", "regions": [{"name": "view", "kind": "image", "input": "dom", "sidecar": "@scope/sidecar-vt", "present": "copy"}]}}}},
	{"id": "browser", "package": "@scope/plugin-browser", "version": "1.0.0",
		"diagnostics": {"module": "ui/diagnostics.js", "exposes": {"status": [{"name": "browser.probe"}]}},
		"manifest": {"id": "browser", "name": "브라우저", "description": "browser", "mark": "www", "icon": "<path d=\"M1 1h14\"/>",
			"surface": {"composition": {"kind": "view", "page": "ui/index.html"}}}}
]}`

// surfaceHost records the surface calls of the workbench.
type surfaceHost struct {
	storedHost
	// window is the state of the window that core.window.workbench reads.
	window   workbench.WindowView
	requests []map[string]any
	placed   int
	declared []string
	replies  []map[string]any
	hostName []string
	// clipboard is the text of the clipboard.
	clipboard string
	debug     debugHost
	// theme is the argument of setTheme, and themeFirst tells that no placement preceded it.
	theme      string
	themeFirst bool
	// elements tells that the host holds the views of the surfaces.
	elements bool
	// calls replaces the calls of the table.
	calls map[string]workbench.HostCall
	// tabs gives the shell its tab ports.
	tabs func(*workbench.Shell) workbench.TabPorts
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
	table["clipboardRead"] = func(_ context.Context, argument json.RawMessage) (any, error) {
		var request struct{ Type string }
		if err := json.Unmarshal(argument, &request); err != nil {
			return nil, err
		}
		if request.Type == "text" && h.clipboard != "" {
			return map[string]any{"present": true, "type": "text", "text": h.clipboard}, nil
		}
		return map[string]any{"present": false, "type": request.Type}, nil
	}
	table["clipboardWriteText"] = func(_ context.Context, argument json.RawMessage) (any, error) {
		return nil, json.Unmarshal(argument, &h.clipboard)
	}
	h.debug.serve(table)
	for _, name := range []string{"viewSidecarRoute", "sidecarListen", "viewEvent", "compositionPlace", "imageAttach", "sidecarSend", "exposureRegister", "documentAttach", "viewRequest", "notify", "notificationRemove"} {
		table[name] = func(_ context.Context, argument json.RawMessage) (any, error) {
			h.hostName = append(h.hostName, name+" "+string(argument))
			return nil, nil
		}
	}
	for name, call := range h.calls {
		table[name] = call
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
func surfaceShellOf(t testing.TB, document string) (*shellFixture, *surfaceHost) {
	t.Helper()
	stored := &surfaceHost{window: workbench.WindowView{Visible: true, Scale: 2, Width: 1200, Height: 800}}
	return surfaceShellOn(t, document, stored), stored
}

// surfaceShellOn is surfaceShellOf over the host stored.
func surfaceShellOn(t testing.TB, document string, stored *surfaceHost) *shellFixture {
	t.Helper()
	declared, err := workbench.Declared()
	if err != nil {
		t.Fatal(err)
	}
	f := &shellFixture{t: t, host: &stored.storedHost, pending: make(steps, 256)}
	shell, err := workbench.NewShell(workbench.ShellOptions{
		Detaching:   func() []string { return nil },
		Located:     func(string) {},
		Backdrop:    func(string) error { return nil },
		Declared:    declared,
		Calls:       workbench.NewCalls(stored.surfaceTable(), f.pending.post),
		Environment: environment(t),
		Installed:   []byte(document),
		Invalidate:  func() { f.frames++ },
		Post:        f.pending.post,
		Report:      func(line string) { f.lines = append(f.lines, line) },
		Element:     func(id string) (uintptr, uintptr, bool) { return stored.element(id) },
		Reload:      func() { f.reloads++ },
		Elements:    fixtureElements{f},
		Tabs:        stored.tabs,
		Window:      func() (workbench.WindowView, error) { return stored.window, nil },
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
	return f
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
	f.run("core.card.split", map[string]string{"card": f.tabbedCards()[0], "side": "right", "plugin": "terminal"})
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
			if start["diagnostics"] != nil || strings.Contains(string(declared), "browser.probe") {
				t.Fatalf("surface %v starts with %v and %s", surface["id"], start, declared)
			}
			continue
		}
		found = true
		if start["diagnostics"].(map[string]any)["module"] != "ui/diagnostics.js" || !strings.Contains(string(declared), "browser.probe") {
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
	reply := viewCall(t, f, stored, surface, "runtime.sidecar.on", map[string]any{"id": surface, "sidecar": "@scope/sidecar-vt"})
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

func TestViewCallAttachesARegionWithoutAHistory(t *testing.T) {
	f, stored := surfaceShell(t)
	surface := anySurface(t, stored)
	reply := viewCall(t, f, stored, surface, "document.attach", map[string]any{"name": "page"})
	result, ok := reply["result"].(map[string]any)
	if reply["error"] != nil || !ok || result["history"] != false {
		t.Fatalf("the reply is %v", reply)
	}
	if !slices.Contains(stored.hostName, fmt.Sprintf(`documentAttach {"document":"page","surface":%q}`, surface)) {
		t.Fatalf("the host calls are %v", stored.hostName)
	}
}

func TestAPressOnAViewFocusesItsCard(t *testing.T) {
	f, _ := surfaceShell(t)
	row := func(id string) float64 {
		for _, card := range f.cardsOf() {
			if card["id"] == id {
				return card["r0"].(float64)
			}
		}
		t.Fatalf("no card %s", id)
		return 0
	}
	cards := f.tabbedCards()
	if len(cards) != 2 || row(cards[0]) == row(cards[1]) {
		t.Fatalf("the views stand in the cards %v", f.cardsOf())
	}
	var surface string
	for _, card := range f.cardsOf() {
		if card["id"] == cards[1] {
			tabs := card["data"].(map[string]any)["tabs"].([]any)
			surface = tabs[0].(map[string]any)["id"].(string)
		}
	}
	f.run("core.card.focus", map[string]string{"card": cards[0]})
	f.shell.Event("surface-pressed", []any{surface})
	f.settle()
	for _, card := range status[gridRead](t, f, "core.grid").Cards {
		if card.Focused != (card.ID == cards[1]) {
			t.Fatalf("after the press on %s the grid holds %+v", cards[1], card)
		}
	}
}

func TestAViewFillsTheCardBetweenItsHeadAndItsFoot(t *testing.T) {
	f, stored := surfaceShell(t)
	const head, foot = 32, 22 // The chrome metrics head-h and foot-h.
	for _, card := range f.tabbedCards() {
		box := f.box("core.card", card)
		top := f.box("core.card.header", card)
		status := f.box("core.card.status", card)
		if got := top.Y + top.H - box.Y; got != cardBorder+head {
			t.Fatalf("the head %+v of the card %+v ends %v below its top", top, box, got)
		}
		if got := box.Y + box.H - status.Y; got != cardBorder+foot {
			t.Fatalf("the foot %+v of the card %+v starts %v above its bottom", status, box, got)
		}
		var data struct {
			Tabs []struct {
				ID string `json:"id"`
			} `json:"tabs"`
		}
		for _, stored := range f.cardsOf() {
			if stored["id"] == card {
				encoded, err := json.Marshal(stored["data"])
				if err != nil {
					t.Fatal(err)
				}
				if err := json.Unmarshal(encoded, &data); err != nil {
					t.Fatal(err)
				}
			}
		}
		surface := stored.lastSurfaces(t)[data.Tabs[0].ID]
		if got := []float64{surface["x"].(float64), surface["y"].(float64), surface["w"].(float64), surface["h"].(float64)}; !slices.Equal(got,
			[]float64{float64(box.X) + cardBorder, float64(box.Y) + cardBorder + head, float64(box.W) - 2*cardBorder, float64(box.H) - 2*cardBorder - head - foot}) {
			t.Fatalf("the view of the card %+v stands at %v", box, got)
		}
	}
}

// A web page paints whole points only, so a native view of a fractional height would show the window below its last row.
func TestAViewStandsOnWholePoints(t *testing.T) {
	f, stored := surfaceShell(t)
	stored.elements = true
	f.run("core.card.focus", map[string]string{"card": f.tabbedCards()[0]})
	surface := stored.lastSurfaces(t)[anySurface(t, stored)]
	height := surface["h"].(float64)
	if height == math.Floor(height) {
		t.Fatalf("the slot height %v is whole, so the test shows nothing", height)
	}
	found := false
	var walk func(nodes []ui.ElementNode)
	walk = func(nodes []ui.ElementNode) {
		for _, node := range nodes {
			if float64(node.Bounds.H) == math.Floor(height) && float64(node.Bounds.W) == surface["w"].(float64) {
				found = true
			}
			walk(node.Children)
		}
	}
	walk(f.tester.ElementTree())
	if !found {
		t.Fatalf("no native view of the height %v stands in the slot of the height %v", math.Floor(height), height)
	}
}

// A view that follows the settings of its plugin hears a change of them, and no change of another setting.
func TestAViewFollowsTheSettingsOfItsPlugin(t *testing.T) {
	f, stored := surfaceShell(t)
	surface := terminalSurface(t, stored)
	if reply := viewCall(t, f, stored, surface, "runtime.settings.on", nil); reply["error"] != nil {
		t.Fatalf("the reply is %v", reply)
	}
	pushed := func() []map[string]any {
		var values []map[string]any
		for _, line := range stored.hostName {
			var event struct {
				Event string
				Data  map[string]any
			}
			if text, found := strings.CutPrefix(line, "viewEvent "); found && json.Unmarshal([]byte(text), &event) == nil && event.Event == "settings" {
				values = append(values, event.Data)
			}
		}
		return values
	}
	f.run("core.settings.change", map[string]any{"key": "gap", "value": 2.0})
	f.settle()
	if got := pushed(); len(got) != 0 {
		t.Fatalf("a change of another setting reached the view: %v", got)
	}
	f.run("core.settings.change", map[string]any{"key": "terminal.cursor.shape", "value": "beam"})
	f.settle()
	if got := pushed(); len(got) != 1 || got[0]["cursor.shape"] != "beam" {
		t.Fatalf("the view received %v", got)
	}
}

// attachShell is a shell whose host stores session as the session of each tab, and refuses a restored history when refuses is set.
// attaches receives each documentAttach request.
func attachShell(t *testing.T, session string, refuses bool) (*shellFixture, *surfaceHost, *[]map[string]any) {
	t.Helper()
	attaches := &[]map[string]any{}
	stored := &surfaceHost{}
	base := stored.table()["workspace"]
	timers := &clock{}
	stored.calls = map[string]workbench.HostCall{
		"workspace": func(ctx context.Context, argument json.RawMessage) (any, error) {
			if strings.Contains(string(argument), `"kind":"tabSession"`) {
				return json.RawMessage(session), nil
			}
			return base(ctx, argument)
		},
		"documentAttach": func(_ context.Context, argument json.RawMessage) (any, error) {
			var request map[string]any
			if err := json.Unmarshal(argument, &request); err != nil {
				return nil, err
			}
			*attaches = append(*attaches, request)
			if _, restores := request["interactionState"]; restores && refuses {
				return nil, fmt.Errorf("the web view refused the interactionState")
			}
			return nil, nil
		},
	}
	stored.tabs = func(*workbench.Shell) workbench.TabPorts {
		return workbench.TabPorts{
			Plugins:        func() []workbench.ShellPlugin { return nil },
			Surfaces:       &fakeSurfaces{mounted: map[string]bool{}},
			Enabled:        func() bool { return false },
			Delay:          func() int { return 120 },
			PluginSettings: func(string) map[string]any { return nil },
			Commit:         func(answer func(error)) { answer(nil) },
			Emit:           func(string, string, map[string]any) {},
			Now:            func() int64 { return timers.now },
			After:          timers.after,
		}
	}
	return surfaceShellOn(t, installedDocument, stored), stored, attaches
}

func TestARegionAttachAnswersWhetherItRestoredAHistory(t *testing.T) {
	const session = `{"regions":{"page":{"session":"c3RhdGU="}}}`
	for _, test := range []struct {
		name     string
		session  string
		refuses  bool
		history  bool
		attaches int
	}{
		{name: "a stored history restores", session: session, history: true, attaches: 1},
		{name: "a refused history attaches again without it", session: session, refuses: true, attaches: 2},
		{name: "another region has no history", session: `{"regions":{"other":{"session":"c3RhdGU="}}}`, attaches: 1},
		{name: "a tab without a session has no history", session: "null", attaches: 1},
	} {
		t.Run(test.name, func(t *testing.T) {
			f, stored, attaches := attachShell(t, test.session, test.refuses)
			surface := anySurface(t, stored)
			// A refused history is recorded as a failure, which settle does not allow.
			f.shell.Event("view-call", []any{map[string]any{"surface": surface, "plugin": "terminal", "generation": 1, "id": 5, "command": "document.attach",
				"params": map[string]any{"name": "page"}}})
			f.pending.drain(t)
			if len(stored.replies) != 1 {
				t.Fatalf("the replies are %v", stored.replies)
			}
			reply := stored.replies[0]
			result, ok := reply["result"].(map[string]any)
			if reply["error"] != nil || !ok || result["history"] != test.history {
				t.Fatalf("the reply is %v", reply)
			}
			if recorded := f.host.written("workbench.record.error"); (len(recorded) == 1) != test.refuses {
				t.Fatalf("the shell recorded %v", recorded)
			}
			if len(*attaches) != test.attaches {
				t.Fatalf("the host took %v", *attaches)
			}
			if _, restores := (*attaches)[len(*attaches)-1]["interactionState"]; restores != test.history {
				t.Fatalf("the last attach is %v", (*attaches)[len(*attaches)-1])
			}
		})
	}
}

// focusedCards returns the cards that the grid holds as focused.
func focusedCards(t *testing.T, f *shellFixture) []string {
	t.Helper()
	var focused []string
	for _, card := range status[gridRead](t, f, "core.grid").Cards {
		if card.Focused {
			focused = append(focused, card.ID)
		}
	}
	return focused
}

// A press reaches the content over a view while the host holds the views of a placement out of the pointer. It still is a
// press on the card, and focuses it as the press goes down.
func TestAPressOnTheSeatOfAViewFocusesItsCard(t *testing.T) {
	f, stored := surfaceShell(t)
	stored.elements = true
	f.settle()
	cards := f.tabbedCards()
	f.run("core.card.focus", map[string]string{"card": cards[0]})
	f.settle()
	box := f.box("core.card", cards[1])
	x, y := box.X+box.W/2, box.Y+box.H/2
	f.tester.Press(x, y)
	f.settle()
	if got := focusedCards(t, f); !slices.Equal(got, []string{cards[1]}) {
		t.Fatalf("after the press on the seat of %s the focused cards are %v", cards[1], got)
	}
	f.tester.Release(x, y)
	f.settle()
	if got := focusedCards(t, f); !slices.Equal(got, []string{cards[1]}) {
		t.Fatalf("after the release on the seat of %s the focused cards are %v", cards[1], got)
	}
}

// The section of a card stands inside the card, so a press on its view is a press on the card: the view that takes it reports
// it, and the seat takes the press that reaches the content.
func TestAPressOnASectionOfACardFocusesTheCard(t *testing.T) {
	section := func(t *testing.T) (*shellFixture, string, string, map[string]any) {
		f, stored := surfaceShellOf(t, sidebarsInstalled)
		stored.elements = true
		cards := f.tabbedCards()
		f.run("core.card.sidebar.set", map[string]string{"card": cards[1], "side": "left", "set": "set-install"})
		f.run("core.card.focus", map[string]string{"card": cards[0]})
		f.settle()
		for id, surface := range stored.lastSurfaces(t) {
			if start, ok := surface["start"].(map[string]any); ok {
				if held, ok := start["section"].(map[string]any); ok && held["card"] == cards[1] {
					return f, cards[1], id, surface
				}
			}
		}
		t.Fatalf("no section stands in the card %s", cards[1])
		return nil, "", "", nil
	}
	t.Run("the view reports it", func(t *testing.T) {
		f, card, id, _ := section(t)
		f.shell.Event("surface-pressed", []any{id})
		f.settle()
		if got := focusedCards(t, f); !slices.Equal(got, []string{card}) {
			t.Fatalf("after the press on the section %s the focused cards are %v", id, got)
		}
	})
	t.Run("the seat takes it", func(t *testing.T) {
		f, card, id, surface := section(t)
		x, y := float32(surface["x"].(float64)+surface["w"].(float64)/2), float32(surface["y"].(float64)+surface["h"].(float64)/2)
		f.tester.Press(x, y)
		f.settle()
		if got := focusedCards(t, f); !slices.Equal(got, []string{card}) {
			t.Fatalf("after the press on the seat of the section %s the focused cards are %v", id, got)
		}
	})
}

// A section of a window sidebar stands in no card, and a press on it leaves the focus of the cards.
func TestAPressOnASectionOfAWindowSidebarLeavesTheFocusedCard(t *testing.T) {
	f, stored := surfaceShellOf(t, sidebarsInstalled)
	stored.elements = true
	cards := f.tabbedCards()
	f.run("core.card.focus", map[string]string{"card": cards[1]})
	f.settle()
	var id string
	for held, surface := range stored.lastSurfaces(t) {
		if strings.HasSuffix(held, "/left/files.tree") && surface["visible"] == true {
			id = held
		}
	}
	if id == "" {
		t.Fatal("no section stands in the left sidebar of the window")
	}
	f.shell.Event("surface-pressed", []any{id})
	f.settle()
	if got := focusedCards(t, f); !slices.Equal(got, []string{cards[1]}) {
		t.Fatalf("after the press on the section %s the focused cards are %v", id, got)
	}
}
