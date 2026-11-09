package workbench_test

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"slices"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/egoist/mygo/ui"

	workbench "github.com/soksak-app/core/packages/workbench-mygo/src"
)

// installedDocument is the document of the installed plugins with one plugin of a view and one without a surface.
const installedDocument = `{"plugins": [
	{"id": "textprobe", "package": "@scope/plugin-textprobe", "version": "1.0.0", "sidecars": {"@scope/sidecar-probe": {}},
		"manifest": {"id": "textprobe", "name": "터미널", "description": "textprobe", "mark": "◊", "icon": "<path d=\"M1 1h14\"/>",
			"dependencies": {"@scope/sidecar-probe": "^1.0.0"},
			"exposes": {"element": [{"name": "textprobe.view", "description": "the view"}], "status": [{"name": "textprobe.screen", "description": "the screen", "schema": {"type": "object", "properties": {}}}], "commands": [{"name": "textprobe.drop", "description": "does it", "params": {"type": "object", "properties": {}}, "result": {"type": "null"}}, {"name": "textprobe.input", "description": "does it", "params": {"type": "object", "properties": {}}, "result": {"type": "null"}}, {"name": "textprobe.close", "description": "does it", "params": {"type": "object", "properties": {}}, "result": {"type": "null"}, "timeout": 40}]},
			"data": {"notes": {"schema": {"type": "string"}, "default": "none", "format": 2},
				"marks": {"schema": {"type": "array", "items": {"type": "string"}}, "default": ["start"]},
				"point": {"schema": {"type": "object"}, "default": {}}},
			"settings": {"cursor.shape": {"type": "enum", "label": "모양", "default": "block", "values": ["block", "beam"]}, "shell": {"type": "string", "label": "셸", "default": "login", "maxLength": 64}},
			"surface": {"menu": [{"title": "닫기", "command": "textprobe.close"}], "drop": "textprobe.drop", "composition": {"kind": "view", "page": "ui/textprobe.html", "regions": [{"name": "view", "kind": "image", "input": "dom", "sidecar": "@scope/sidecar-probe", "present": "copy"}]}}}},
	{"id": "boxprobe", "package": "@scope/plugin-boxprobe", "version": "1.0.0",
		"diagnostics": {"module": "ui/diagnostics.js", "exposes": {"status": [{"name": "boxprobe.probe"}]}},
		"manifest": {"id": "boxprobe", "name": "브라우저", "description": "boxprobe", "mark": "www", "icon": "<path d=\"M1 1h14\"/>",
			"surface": {"composition": {"kind": "view", "page": "ui/index.html"}}, "sections": [
				{"id": "boxprobe.tabs", "name": "탭", "composition": {"kind": "view", "page": "ui/section.html"}, "height": 160},
				{"id": "boxprobe.history", "name": "기록", "composition": {"kind": "view", "page": "ui/section.html"}, "height": "fill"},
				{"id": "boxprobe.dom", "name": "DOM", "composition": {"kind": "view", "page": "ui/section.html"}, "height": "fill"},
				{"id": "boxprobe.network", "name": "네트워크", "composition": {"kind": "view", "page": "ui/section.html"}, "height": "fill"}]}}
]}`

// surfaceHost records the surface calls of the workbench.
type surfaceHost struct {
	storedHost
	// now is the clock of the window, which only a test moves.
	now time.Time
	// window is the state of the window that core.window.workbench reads.
	window          workbench.WindowView
	windowReads     int
	viewWindowReads []int
	// windowFailure is the error of each read of the state of the window.
	windowFailure error
	// presentFailure and declareFailure are the errors of each presentSurfaces and compositionDeclare, and syncFailure the error of
	// each syncSurfaces.
	presentFailure error
	syncFailure    error
	// presentFailureFrom is the number of syncSurfaces from which presentFailure fails presentSurfaces, and 0 for every one.
	presentFailureFrom int
	// transaction tells that a layout transaction of the window is open, so a frame opens none; opened holds the ticket of each
	// layout that a frame opened, openedAt the number of host calls made before each opening, which is no host call of a page, and
	// cancelled the ticket of each cancelSurfaces.
	transaction bool
	opened      []uint64
	openedAt    []int
	cancelled   []uint64
	// pending is the opened layout that no preparation took over and no cancel ended, which holds the frames of the window as the
	// host does: while it stands, no other frame opens a layout.
	pending uint64
	// presentGate, when set, holds each presentSurfaces until it closes, so a frame draws while a placement runs.
	presentGate    chan struct{}
	declareFailure error
	// presentedFailure is the error of each waitPresented, while a surface has not presented.
	presentedFailure error
	requests         []map[string]any
	placed           int
	declared         []string
	replies          []map[string]any
	hostName         []string
	hostNameMu       sync.Mutex
	// clipboard is the text of the clipboard.
	clipboard string
	debug     debugHost
	// theme is the argument of setTheme, and themeFirst tells that no placement preceded it.
	theme      string
	themeFirst bool
	// elements tells that the host holds the views of the surfaces. Without ownViews every surface has the same view, which the
	// framework places once, so a press over any other surface reaches the content as while the host holds the views of a placement
	// out of the pointer; with ownViews views holds the view of each surface, one for each, as the host makes them.
	elements bool
	ownViews bool
	views    map[string]uintptr
	// calls replaces the calls of the table.
	calls map[string]workbench.HostCall
	// held is the surfaces of the last syncSurfaces, which the host holds whichever table answered it.
	held []string
	// tabs gives the shell its tab ports.
	tabs func(*workbench.Shell) workbench.TabPorts
	// keyboard holds the argument of each surfaceFocus, decided whether each carried decided, and order the host calls of a
	// placement in their order.
	keyboard []*string
	decided  []bool
	order    []string
	// orderMu guards keyboard and order, which a call writes in its routine and a test reads in an answer.
	orderMu sync.Mutex
}

// called records the call name in the order of the calls.
func (h *surfaceHost) called(name string) {
	h.orderMu.Lock()
	defer h.orderMu.Unlock()
	h.order = append(h.order, name)
}

// calledNow returns the calls so far and the target of the last keyboard call, nil for the workbench or without one.
func (h *surfaceHost) calledNow() (string, *string) {
	h.orderMu.Lock()
	defer h.orderMu.Unlock()
	var target *string
	if len(h.keyboard) > 0 {
		target = h.keyboard[len(h.keyboard)-1]
	}
	return strings.Join(h.order, " "), target
}

// holds tells whether the last syncSurfaces held the surface id.
func (h *surfaceHost) holds(id string) bool {
	h.orderMu.Lock()
	defer h.orderMu.Unlock()
	return slices.Contains(h.held, id)
}

// keyboardTarget returns the surface of the last surfaceFocus, nil for the workbench, and whether there was one.
func (h *surfaceHost) keyboardTarget() (*string, bool) {
	if len(h.keyboard) == 0 {
		return nil, false
	}
	return h.keyboard[len(h.keyboard)-1], true
}

func (h *surfaceHost) surfaceTable() map[string]workbench.HostCall {
	table := h.table()
	table["syncSurfaces"] = func(_ context.Context, argument json.RawMessage) (any, error) {
		if h.syncFailure != nil {
			return nil, h.syncFailure
		}
		var request map[string]any
		if err := json.Unmarshal(argument, &request); err != nil {
			return nil, err
		}
		h.requests = append(h.requests, request)
		h.called("syncSurfaces")
		return map[string]any{"ticket": len(h.requests), "placements": []any{}, "chrome": map[string]any{}}, nil
	}
	table["cancelSurfaces"] = func(_ context.Context, argument json.RawMessage) (any, error) {
		var request struct{ Ticket uint64 }
		if err := json.Unmarshal(argument, &request); err != nil {
			return nil, err
		}
		h.orderMu.Lock()
		h.cancelled = append(h.cancelled, request.Ticket)
		if h.pending == request.Ticket {
			h.pending = 0
		}
		h.orderMu.Unlock()
		h.called("cancelSurfaces")
		return nil, nil
	}
	table["waitPresented"] = func(context.Context, json.RawMessage) (any, error) {
		return 0, h.presentedFailure
	}
	table["presentSurfaces"] = func(context.Context, json.RawMessage) (any, error) {
		if h.presentFailure != nil && len(h.requests) >= h.presentFailureFrom {
			return nil, h.presentFailure
		}
		h.orderMu.Lock()
		gate := h.presentGate
		h.orderMu.Unlock()
		if gate != nil {
			<-gate
		}
		h.placed++
		h.called("presentSurfaces")
		return []any{}, nil
	}
	table["surfaceFocus"] = func(_ context.Context, argument json.RawMessage) (any, error) {
		var request struct {
			Surface *string `json:"surface"`
			Decided bool    `json:"decided"`
		}
		if err := json.Unmarshal(argument, &request); err != nil {
			return nil, err
		}
		// The host holds the surfaces of the last syncSurfaces and refuses a surface that it does not hold
		// (docs/spec/host-contract.md, surface-layout.keyboard-follows-the-focus-ring).
		if request.Surface != nil && !h.holds(*request.Surface) {
			return nil, fmt.Errorf("surface %q is not attached", *request.Surface)
		}
		h.orderMu.Lock()
		h.keyboard = append(h.keyboard, request.Surface)
		h.decided = append(h.decided, request.Decided)
		h.orderMu.Unlock()
		h.called("surfaceFocus")
		return nil, nil
	}
	table["compositionDeclare"] = func(_ context.Context, argument json.RawMessage) (any, error) {
		if h.declareFailure != nil {
			return nil, h.declareFailure
		}
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
	for _, name := range []string{"viewSidecarRoute", "sidecarListen", "viewEvent", "compositionPlace", "imageAttach", "sidecarSend", "viewSidecarSend", "exposureRegister", "documentAttach", "viewRequest", "notify", "notificationRemove"} {
		table[name] = func(_ context.Context, argument json.RawMessage) (any, error) {
			// Each host call runs on a goroutine of its own.
			h.hostNameMu.Lock()
			defer h.hostNameMu.Unlock()
			h.hostName = append(h.hostName, name+" "+string(argument))
			return nil, nil
		}
	}
	for name, call := range h.calls {
		table[name] = call
	}
	sync := table["syncSurfaces"]
	table["syncSurfaces"] = func(ctx context.Context, argument json.RawMessage) (any, error) {
		var request struct {
			Surfaces []struct{ ID string } `json:"surfaces"`
		}
		if err := json.Unmarshal(argument, &request); err != nil {
			return nil, err
		}
		held := make([]string, 0, len(request.Surfaces))
		for _, surface := range request.Surfaces {
			held = append(held, surface.ID)
		}
		// The preparation takes the opened layout over, and the host cancels it when the preparation fails.
		h.orderMu.Lock()
		h.held = held
		taken := h.pending
		h.pending = 0
		h.orderMu.Unlock()
		value, err := sync(ctx, argument)
		if err != nil && taken != 0 {
			h.orderMu.Lock()
			h.cancelled = append(h.cancelled, taken)
			h.orderMu.Unlock()
		}
		return value, err
	}
	return table
}

// openLayout opens the layout transaction of the window for the frame being drawn, unless one is open, as the host does.
func (h *surfaceHost) openLayout() (uint64, error) {
	if h.transaction {
		return 0, nil
	}
	h.orderMu.Lock()
	defer h.orderMu.Unlock()
	if h.pending != 0 {
		return 0, fmt.Errorf("the window holds its frames for the layout %d that no preparation took over", h.pending)
	}
	ticket := uint64(1000 + len(h.opened))
	h.pending = ticket
	h.opened = append(h.opened, ticket)
	h.openedAt = append(h.openedAt, len(h.order))
	return ticket, nil
}

// element returns the views of a surface once the host holds them: the view of the surface and the view inside it that takes the
// keyboard.
func (h *surfaceHost) element(id string) (uintptr, uintptr, bool) {
	if !h.elements {
		return 0, 0, false
	}
	if !h.ownViews {
		return 1, 2, true
	}
	if h.views == nil {
		h.views = map[string]uintptr{}
	}
	view, ok := h.views[id]
	if !ok {
		view = uintptr(2*len(h.views) + 1)
		h.views[id] = view
	}
	return view, view + 1, true
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
	// A window has a backing scale, and the verification of each frame reads it.
	if stored.window.Scale == 0 {
		stored.window = workbench.WindowView{Visible: true, Scale: 2, Width: 1200, Height: 800}
	}
	declared, err := workbench.Declared()
	if err != nil {
		t.Fatal(err)
	}
	f := &shellFixture{t: t, host: &stored.storedHost, pending: make(steps, 256)}
	shell, err := workbench.NewShell(workbench.ShellOptions{
		Now:         func() time.Time { return stored.now },
		Detaching:   func() []string { return nil },
		Located:     func(string) {},
		Backdrop:    func(string) error { return nil },
		FirstScreen: func() {},
		Declared:    declared,
		Calls:       workbench.NewCalls(stored.surfaceTable(), f.pending.post),
		Environment: environment(t),
		Installed:   []byte(document),
		Invalidate:  func() { f.frames++ },
		Post:        f.pending.post,
		Report:      func(line string) { f.lines = append(f.lines, line) },
		Element:     func(id string) (uintptr, uintptr, bool) { return stored.element(id) },
		OpenLayout:  stored.openLayout,
		Reload:      func() { f.reloads++ },
		Elements:    fixtureElements{f},
		Tabs:        stored.tabs,
		Window:      func() (workbench.WindowView, error) { stored.windowReads++; return stored.window, stored.windowFailure },
	})
	if err != nil {
		t.Fatal(err)
	}
	f.shell = shell
	f.tester = ui.NewTester(func(c *ui.Context) {
		before := stored.windowReads
		shell.View(c)
		stored.viewWindowReads = append(stored.viewWindowReads, stored.windowReads-before)
	}, 1200, 800)
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
	f.run("core.card.split", map[string]string{"card": f.tabbedCards()[0], "side": "right", "plugin": "textprobe"})
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
	f.shell.Event("view-call", []any{map[string]any{"surface": surface, "plugin": "textprobe", "generation": 1, "id": 5, "command": command, "params": params}})
	f.settle()
	return viewReply(t, stored, surface, command)
}

// viewCallShowing is viewCall for a call whose result the error display shows: it takes the records of the shown errors before
// the frames that settle the call, which fail on a record that no test took.
func viewCallShowing(t *testing.T, f *shellFixture, stored *surfaceHost, surface, command string, params any) []shownRecord {
	t.Helper()
	f.shell.Event("view-call", []any{map[string]any{"surface": surface, "plugin": "textprobe", "generation": 1, "id": 5, "command": command, "params": params}})
	records := f.shownRecords()
	f.settle()
	viewReply(t, stored, surface, command)
	return records
}

// viewReply returns the last reply of a view call, which answers the call of surface.
func viewReply(t *testing.T, stored *surfaceHost, surface, command string) map[string]any {
	t.Helper()
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
		if surface["plugin"] != "boxprobe" {
			if start["diagnostics"] != nil || strings.Contains(string(declared), "boxprobe.probe") {
				t.Fatalf("surface %v starts with %v and %s", surface["id"], start, declared)
			}
			continue
		}
		found = true
		if start["diagnostics"].(map[string]any)["module"] != "ui/diagnostics.js" || !strings.Contains(string(declared), "boxprobe.probe") {
			t.Fatalf("the view starts with %v and %s", start, declared)
		}
	}
	if !found {
		t.Fatal("no surface of the boxprobe plugin")
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
	reply := viewCall(t, f, stored, surface, "runtime.sidecar.on", map[string]any{"id": surface, "sidecar": "@scope/sidecar-probe"})
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
	if reply := viewCall(t, f, stored, surface, "tab.focus", map[string]any{"name": "boxprobe.address", "index": 0}); reply["error"] != nil {
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
		scale := stored.window.Scale
		x, y, w, h := surface["x"].(float64), surface["y"].(float64), surface["w"].(float64), surface["h"].(float64)
		got := []float64{x * scale, y * scale, (x + w) * scale, (y + h) * scale}
		want := []float64{math.Round((float64(box.X) + cardBorder) * scale),
			math.Round(float64(top.Y+top.H) * scale), math.Round((float64(box.X+box.W) - cardBorder) * scale),
			math.Round(float64(status.Y) * scale)}
		if !slices.Equal(got, want) {
			t.Fatalf("the declared view of card %+v has physical edges %v, want exact card/header/footer edges %v at scale %v", box, got, want, scale)
		}
		for _, edge := range got {
			if edge != math.Round(edge) {
				t.Fatalf("the declared view edge %v is not an actual backing-pixel edge", edge)
			}
		}
	}
}

// A view fills its slot, also when the lines of the plane lie between device pixels, and the head and the foot of a card touch it: the
// framework rounds each edge to the nearest device pixel, so a view off its slot would show a device pixel of the card.
func TestAViewTouchesTheHeadAndTheFootOfItsCard(t *testing.T) {
	f, stored := surfaceShell(t)
	stored.elements = true
	f.run("core.card.focus", map[string]string{"card": f.tabbedCards()[0]})
	grid := status[struct {
		Cards []struct{ H float64 } `json:"cards"`
	}](t, f, "core.grid")
	fractional := false
	for _, card := range grid.Cards {
		fractional = fractional || card.H != math.Round(card.H)
	}
	if !fractional {
		t.Fatalf("every card height of %+v is whole, so the test shows nothing", grid.Cards)
	}
	scale := float32(stored.window.Scale)
	device := func(edge float32) float64 { return math.Round(float64(edge * scale)) }
	var views []ui.Rect
	var walk func(nodes []ui.ElementNode)
	walk = func(nodes []ui.ElementNode) {
		for _, node := range nodes {
			if _, ok := node.Key.(workbench.SurfaceSlot); ok {
				if len(node.Children) != 1 {
					t.Fatalf("the slot %+v holds %d elements", node.Bounds, len(node.Children))
				}
				view, slot := node.Children[0].Bounds, node.Bounds
				viewEdges := []float64{device(view.X), device(view.Y), device(view.X + view.W), device(view.Y + view.H)}
				slotEdges := []float64{device(slot.X), device(slot.Y), device(slot.X + slot.W), device(slot.Y + slot.H)}
				if !slices.Equal(viewEdges, slotEdges) {
					t.Errorf("the view %+v has physical edges %v and does not fill the slot %+v with physical edges %v at scale %v", view, viewEdges, slot, slotEdges, scale)
				}
				views = append(views, node.Children[0].Bounds)
			}
			walk(node.Children)
		}
	}
	walk(f.tester.ElementTree())
	touched := 0
	for _, card := range f.tabbedCards() {
		box, head, foot := f.box("core.card", card), f.box("core.card.header", card), f.box("core.card.status", card)
		for _, view := range views {
			if view.X < box.X || view.X+view.W > box.X+box.W || view.Y < box.Y || view.Y+view.H > box.Y+box.H {
				continue
			}
			touched++
			if device(view.Y) != device(head.Y+head.H) || device(view.Y+view.H) != device(foot.Y) {
				t.Errorf("the view %+v of %s does not touch the head %+v and the foot %+v at the scale %v", view, card, head, foot, scale)
			}
		}
	}
	if touched == 0 {
		t.Fatalf("no view stands in a tabbed card: %+v", views)
	}
}

// A view takes the pointer wherever it shows, up to its edges, as the native view of a page host stands over the page: the grab area of
// a boundary, which reaches over the edges of the cards beside it, stays out of the view. A press near the left edge of the first cell
// of a terminal reaches the terminal, not the boundary.
func TestAViewTakesThePointerUpToItsEdges(t *testing.T) {
	// A theme without a gap leaves the passage between two cards narrower than the grab area of their boundary, which then reaches
	// over the edge of the view of each card beside it. The plane takes the gap as it opens.
	stored := &surfaceHost{window: workbench.WindowView{Visible: true, Scale: 2, Width: 1200, Height: 800}}
	stored.common = map[string]any{"theme": "slate", "gap": 0.0}
	f := surfaceShellOn(t, installedDocument, stored)
	stored.elements, stored.ownViews = true, true
	// The frame has the backing scale of the window, at whose device pixels the framework stands each view.
	f.tester.SetScale(float32(stored.window.Scale))
	f.settle()
	var views, dividers []ui.Rect
	var walk func(nodes []ui.ElementNode)
	walk = func(nodes []ui.ElementNode) {
		for _, node := range nodes {
			if _, ok := node.Key.(workbench.SurfaceSlot); ok {
				views = append(views, node.Bounds)
			}
			if exposed, ok := node.Key.(workbench.Exposed); ok && exposed.Name == "core.divider" {
				dividers = append(dividers, node.Bounds)
			}
			walk(node.Children)
		}
	}
	walk(f.tester.ElementTree())
	overlap := func(a, b ui.Rect) bool { return a.X < b.X+b.W && b.X < a.X+a.W && a.Y < b.Y+b.H && b.Y < a.Y+a.H }
	reached := 0
	for _, view := range views {
		for _, divider := range dividers {
			if overlap(view, divider) {
				reached++
			}
		}
	}
	if reached == 0 {
		t.Fatalf("no grab area of a boundary reaches over a view, so the test shows nothing: views %+v, dividers %+v", views, dividers)
	}
	for _, view := range views {
		var covered []ui.Point
		for _, in := range []float32{0.5, 1, 1.5} {
			for along := float32(in); along < view.H-in; along++ {
				for _, x := range []float32{view.X + in, view.X + view.W - in} {
					if f.tester.WebViewAt(x, view.Y+along) == nil {
						covered = append(covered, ui.Point{X: x, Y: view.Y + along})
					}
				}
			}
			for along := float32(in); along < view.W-in; along++ {
				for _, y := range []float32{view.Y + in, view.Y + view.H - in} {
					if f.tester.WebViewAt(view.X+along, y) == nil {
						covered = append(covered, ui.Point{X: view.X + along, Y: y})
					}
				}
			}
		}
		if len(covered) > 0 {
			t.Errorf("the view %+v does not take the pointer at %d points inside its edges, the first %+v; the dividers are %+v", view,
				len(covered), covered[0], dividers)
		}
	}
}

// Each start of a run tells each view once, and no later step of the run does (docs/spec/native-surfaces.md#view-surfaces).
func TestEachStartOfARunTellsEachViewOnce(t *testing.T) {
	f, stored := surfaceShell(t)
	left := f.tabbedCards()[0]
	made, err := f.answer("core.card.split", map[string]string{"card": left, "side": "right", "plugin": "textprobe"})
	if err != nil {
		t.Fatal(err)
	}
	right := made["card"].(string)
	f.settle()
	surfaces := stored.lastSurfaces(t)
	if len(surfaces) < 2 {
		t.Fatalf("the split shell has %d surfaces", len(surfaces))
	}
	for surface := range surfaces {
		viewCall(t, f, stored, surface, "runtime.settings.on", nil)
	}
	starts := func() map[string]int {
		counts := map[string]int{}
		stored.hostNameMu.Lock()
		defer stored.hostNameMu.Unlock()
		for _, line := range stored.hostName {
			var event struct {
				Surface string
				Event   string
				Data    any
			}
			if text, found := strings.CutPrefix(line, "viewEvent "); found && json.Unmarshal([]byte(text), &event) == nil && event.Event == "run-start" {
				// The host call refuses an event whose data is null, as a missing field (docs/spec/native-host.md#host-calls).
				if data, isObject := event.Data.(map[string]any); !isObject || len(data) != 0 {
					t.Fatalf("run-start carries %v", event.Data)
				}
				counts[event.Surface]++
			}
		}
		return counts
	}
	drag := func(round int) {
		t.Helper()
		box, _ := f.divider(left, right)
		x, y := box.X+box.W/2, box.Y+box.H/2
		f.tester.Move(x, y)
		f.tester.Frame()
		f.tester.Press(x, y)
		f.tester.Frame()
		for _, step := range []float32{-20, -40, -60} {
			f.tester.Move(x+step, y)
			f.settle()
		}
		for surface := range surfaces {
			if got := starts()[surface]; got != round {
				t.Fatalf("after %d drags the view %s heard %d starts during the drag", round, surface, got)
			}
		}
		if settled := stored.requests[len(stored.requests)-1]["settled"]; settled != false {
			t.Fatalf("a placement of the drag has settled %v", settled)
		}
		f.tester.Release(x-60, y)
		f.settle()
		// The host ends the run on a settled placement, also when the release moved nothing.
		if settled := stored.requests[len(stored.requests)-1]["settled"]; settled != true {
			t.Fatalf("the last placement of the drag has settled %v", settled)
		}
	}
	drag(1)
	drag(2)
	for surface := range surfaces {
		if got := starts()[surface]; got != 2 {
			t.Fatalf("the view %s heard %d starts of two drags", surface, got)
		}
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
	f.run("core.settings.change", map[string]any{"key": "textprobe.cursor.shape", "value": "beam"})
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
			f.shell.Event("view-call", []any{map[string]any{"surface": surface, "plugin": "textprobe", "generation": 1, "id": 5, "command": "document.attach",
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
		if strings.HasSuffix(held, "/left/fieldprobe.tree") && surface["visible"] == true {
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

func TestALayoutFaultFailsOneDrawAndLeavesTheShellAnswering(t *testing.T) {
	f, stored := surfaceShell(t)
	answered := false
	f.shell.Registry().Reply("diagnostics.layout.fail", json.RawMessage(`{}`), nil, func(value any, err error) {
		answered = true
		if value != nil || err != nil {
			t.Fatalf("diagnostics.layout.fail answered %v, %v", value, err)
		}
	})
	f.settle()
	if !answered {
		t.Fatal("diagnostics.layout.fail did not answer")
	}
	before, presented := len(stored.requests), stored.placed
	f.tester.SetSize(1160, 800)
	shown := f.shownErrors()
	if len(shown) != 1 || !strings.Contains(shown[0], "surface presentation failed: diagnostic layout fault") {
		t.Fatalf("the fault showed %q", shown)
	}
	// The fault fails one draw, and the next draw of the window places the views again.
	f.settle()
	if len(stored.requests) <= before || stored.placed <= presented {
		t.Fatalf("after the fault %d of %d requests, %d of %d presented", len(stored.requests), before, stored.placed, presented)
	}
	if status[map[string]any](t, f, "core.grid") == nil {
		t.Fatal("the shell does not answer after the fault")
	}
}

func TestALayoutFaultFailsOnlyTheNextDraw(t *testing.T) {
	f, _ := surfaceShell(t)
	f.shell.Registry().Reply("diagnostics.layout.fail", json.RawMessage(`{}`), nil, func(any, error) {})
	f.settle()
	f.tester.SetSize(1160, 800)
	if shown := f.shownErrors(); len(shown) != 1 {
		t.Fatalf("the fault showed %q", shown)
	}
	f.tester.SetSize(1100, 800)
	f.settle()
}

// The placement after a fault succeeds, so the banner withdraws the failure of the placement, and the record of the failure stays.
func TestARecoveredPlacementWithdrawsItsError(t *testing.T) {
	f, _ := surfaceShell(t)
	f.shell.Registry().Reply("diagnostics.layout.fail", json.RawMessage(`{}`), nil, func(any, error) {})
	f.settle()
	f.tester.SetSize(1160, 800)
	if shown := f.shownErrors(); len(shown) != 1 {
		t.Fatalf("the fault showed %q", shown)
	}
	f.settle()
	if got := f.status("core.workbench.error"); got != "null" {
		t.Fatalf("after the placement that succeeded the banner holds %s", got)
	}
}

// A window that returns to the lines of the last placement before the next frame recovers as well.
func TestAFaultOfTheSameLinesIsWithdrawnByTheNextPlacement(t *testing.T) {
	f, stored := surfaceShell(t)
	f.tester.SetSize(1160, 800)
	f.settle()
	f.shell.Registry().Reply("diagnostics.layout.fail", json.RawMessage(`{}`), nil, func(any, error) {})
	f.settle()
	f.tester.SetSize(1100, 800)
	if shown := f.shownErrors(); len(shown) != 1 {
		t.Fatalf("the fault showed %q", shown)
	}
	f.tester.SetSize(1160, 800)
	placed := stored.placed
	f.settle()
	if stored.placed <= placed {
		t.Fatal("the frames after the fault placed nothing")
	}
	if got := f.status("core.workbench.error"); got != "null" {
		t.Fatalf("after the window came back the banner holds %s", got)
	}
}

// A placement that keeps failing keeps its error, and the first that succeeds withdraws it.
func TestAPlacementThatKeepsFailingKeepsItsError(t *testing.T) {
	f, stored := surfaceShell(t)
	stored.presentFailure = errors.New("the host refused the placement")
	f.tester.SetSize(1160, 800)
	f.shownErrors()
	f.tester.SetSize(1100, 800)
	f.shownErrors()
	if got := f.status("core.workbench.error"); !strings.Contains(got, "the host refused the placement") {
		t.Fatalf("while the placement fails the banner holds %s", got)
	}
	stored.presentFailure = nil
	f.tester.SetSize(1160, 800)
	f.settle()
	if got := f.status("core.workbench.error"); got != "null" {
		t.Fatalf("after the placement that succeeded the banner holds %s", got)
	}
}

// While a surface has not presented, the placement of another change leaves the failure, because it is still true. When the surface
// presents, the next wait withdraws it.
func TestAFailureStaysUntilTheSurfacesPresent(t *testing.T) {
	f, stored := surfaceShell(t)
	stored.presentFailure = errors.New("the current image raster did not present")
	f.tester.SetSize(1160, 800)
	f.shownErrors()
	stored.presentFailure = nil
	stored.presentedFailure = errors.New("the current image raster did not present")
	f.tester.SetSize(1100, 800)
	f.settle()
	if got := f.status("core.workbench.error"); !strings.Contains(got, "did not present") {
		t.Fatalf("while the surface has not presented the banner holds %s", got)
	}
	stored.presentedFailure = nil
	time.Sleep(1100 * time.Millisecond)
	f.settle()
	if got := f.status("core.workbench.error"); got != "null" {
		t.Fatalf("after the surface presented the banner holds %s", got)
	}
}

// The banner shows the last error of its place. The recovery of a placement withdraws only the failure of that placement.
func TestARecoveredPlacementLeavesAnotherError(t *testing.T) {
	f, stored := surfaceShell(t)
	stored.presentFailure = errors.New("the host refused the placement")
	f.tester.SetSize(1160, 800)
	f.shownErrors()
	stored.presentFailure = nil
	stored.declareFailure = errors.New("the host refused the declaration")
	raw, err := json.Marshal(map[string]string{"card": f.tabbedCards()[0], "plugin": "textprobe"})
	if err != nil {
		t.Fatal(err)
	}
	f.shell.Registry().RunLater("core.card.add-tab", raw, func(any, error) {})
	f.shownErrors()
	f.shownErrors()
	if got := f.status("core.workbench.error"); !strings.Contains(got, "the host refused the declaration") {
		t.Fatalf("after the placement that succeeded the banner holds %s", got)
	}
}

// A command whose placement fails answers with the result of its handler, and the placement shows its failure in one line as the
// layout queue of the main page shows it (docs/spec/exposure.md#registration, docs/spec/hosts.md#application-log).
func TestACommandWhosePlacementFailsAnswersItsResult(t *testing.T) {
	f, stored := surfaceShell(t)
	stored.presentFailure = errors.New("the current image raster did not present within 10s")
	raw, err := json.Marshal(map[string]string{"card": f.tabbedCards()[0], "side": "right", "plugin": "textprobe"})
	if err != nil {
		t.Fatal(err)
	}
	answered := false
	var value any
	var failure error
	f.shell.Registry().RunLater("core.card.split", raw, func(answer any, err error) { answered, value, failure = true, answer, err })
	shown := f.shownErrors()
	if !answered || failure != nil {
		t.Fatalf("the split answered %t with %v", answered, failure)
	}
	var made struct {
		Tab string `json:"tab"`
	}
	if encoded, err := json.Marshal(value); err != nil || json.Unmarshal(encoded, &made) != nil || made.Tab == "" {
		t.Fatalf("the split answered %v, not its tab", value)
	}
	want := "surface presentation failed: " + stored.presentFailure.Error()
	if len(shown) != 1 || shown[0] != want {
		t.Fatalf("the failure showed %q, want one %q", shown, want)
	}
}

// textScope returns the scope of the status core.text.
func textScope(t *testing.T, f *shellFixture) workbench.TextScope {
	t.Helper()
	var text struct {
		Scope workbench.TextScope `json:"scope"`
	}
	if err := json.Unmarshal([]byte(f.status("core.text")), &text); err != nil {
		t.Fatal(err)
	}
	return text.Scope
}

// leaveForTheFrame presses the frame, so that the scope is not the one that the focused card gives.
func leaveForTheFrame(t *testing.T, f *shellFixture) {
	t.Helper()
	pressElement(f, "core.brand", "")
	f.tester.Release(0, 0)
	f.settle()
	if got := textScope(t, f); got != workbench.FrameScope() {
		t.Fatalf("after the press on the frame the scope is %+v", got)
	}
}

// pressElement presses the middle of an element and does not release it.
func pressElement(f *shellFixture, name, item string) {
	f.t.Helper()
	box := f.box(name, item)
	f.tester.Press(box.X+box.W/2, box.Y+box.H/2)
	f.settle()
}

// The scope of the text size is the place the user pressed last, whatever in it the press lands on.
func TestAPressMovesTheTextScope(t *testing.T) {
	card := func(id string) workbench.TextScope { return workbench.CardScope(id) }
	t.Run("the head of a card", func(t *testing.T) {
		f, _ := surfaceShell(t)
		cards := f.tabbedCards()
		f.run("core.card.focus", map[string]string{"card": cards[0]})
		f.settle()
		pressElement(f, "core.card.header", cards[1])
		if got := textScope(t, f); got != card(cards[1]) {
			t.Fatalf("the scope is %+v", got)
		}
	})
	t.Run("a control of a card", func(t *testing.T) {
		f, _ := surfaceShell(t)
		cards := f.tabbedCards()
		f.run("core.card.focus", map[string]string{"card": cards[0]})
		f.settle()
		var tab string
		for _, stored := range f.cardsOf() {
			if stored["id"] == cards[1] {
				tab = stored["data"].(map[string]any)["tabs"].([]any)[0].(map[string]any)["id"].(string)
			}
		}
		pressElement(f, "core.card.tab-close", tab)
		if got := textScope(t, f); got != card(cards[1]) {
			t.Fatalf("the scope is %+v", got)
		}
	})
	t.Run("the seat of a view", func(t *testing.T) {
		f, stored := surfaceShell(t)
		stored.elements = true
		f.settle()
		cards := f.tabbedCards()
		f.run("core.card.focus", map[string]string{"card": cards[0]})
		f.settle()
		leaveForTheFrame(t, f)
		box := f.box("core.card", cards[1])
		f.tester.Press(box.X+box.W/2, box.Y+box.H/2)
		f.settle()
		if got := textScope(t, f); got != card(cards[1]) {
			t.Fatalf("the scope is %+v", got)
		}
		pointer := status[struct{ Down *string }](t, f, "core.pointer")
		if pointer.Down == nil || *pointer.Down != "core.card" {
			t.Fatalf("the pointer sequence went down on %v", pointer.Down)
		}
	})
	t.Run("a view that takes the press", func(t *testing.T) {
		f, stored := surfaceShell(t)
		cards := f.tabbedCards()
		f.run("core.card.focus", map[string]string{"card": cards[0]})
		f.settle()
		var surface string
		for id, placed := range stored.lastSurfaces(t) {
			if placed["visible"] == true && f.cardOfTab(id) == cards[1] {
				surface = id
			}
		}
		leaveForTheFrame(t, f)
		f.shell.Event("surface-pressed", []any{surface})
		f.settle()
		if got := textScope(t, f); got != card(cards[1]) {
			t.Fatalf("the scope is %+v", got)
		}
	})
	t.Run("the focused card itself", func(t *testing.T) {
		f, _ := surfaceShell(t)
		cards := f.tabbedCards()
		f.run("core.card.focus", map[string]string{"card": cards[1]})
		f.settle()
		pressElement(f, "core.brand", "")
		if got := textScope(t, f); got != workbench.FrameScope() {
			t.Fatalf("after the press on the frame the scope is %+v", got)
		}
		pressElement(f, "core.card.header", cards[1])
		if got := textScope(t, f); got != card(cards[1]) {
			t.Fatalf("the scope is %+v", got)
		}
	})
	t.Run("a section of a card", func(t *testing.T) {
		f, stored := surfaceShellOf(t, sidebarsInstalled)
		cards := f.tabbedCards()
		f.run("core.card.sidebar.set", map[string]string{"card": cards[1], "side": "left", "set": "set-install"})
		f.run("core.card.focus", map[string]string{"card": cards[0]})
		f.settle()
		section := ""
		for id := range stored.lastSurfaces(t) {
			if strings.Contains(id, "/"+cards[1]+":left/") {
				section = id
			}
		}
		leaveForTheFrame(t, f)
		f.shell.Event("surface-pressed", []any{section})
		f.settle()
		if got := textScope(t, f); got != card(cards[1]) {
			t.Fatalf("after the press on %q the scope is %+v", section, got)
		}
	})
	t.Run("a window sidebar", func(t *testing.T) {
		f, stored := surfaceShellOf(t, sidebarsInstalled)
		cards := f.tabbedCards()
		f.run("core.card.focus", map[string]string{"card": cards[1]})
		f.settle()
		section := ""
		for id := range stored.lastSurfaces(t) {
			if strings.HasSuffix(id, "/left/fieldprobe.tree") {
				section = id
			}
		}
		f.shell.Event("surface-pressed", []any{section})
		f.settle()
		if got := textScope(t, f); got != card("left") {
			t.Fatalf("after the press on %q the scope is %+v", section, got)
		}
		if got := focusedCards(t, f); !slices.Equal(got, []string{cards[1]}) {
			t.Fatalf("the press moved the focused card to %v", got)
		}
		f.run("core.card.focus", map[string]string{"card": cards[0]})
		f.settle()
		pressElement(f, "core.card", "left")
		if got := textScope(t, f); got != card("left") {
			t.Fatalf("after the press on the sidebar the scope is %+v", got)
		}
		f.run("core.text.larger", nil)
		f.settle()
		var text struct {
			Cards map[string]float64 `json:"cards"`
		}
		if err := json.Unmarshal([]byte(f.status("core.text")), &text); err != nil {
			t.Fatal(err)
		}
		if text.Cards["left"] == 1 || text.Cards[cards[0]] != 1 {
			t.Fatalf("the change of the sidebar left the factors %v", text.Cards)
		}
	})
	t.Run("the frame", func(t *testing.T) {
		f, _ := surfaceShell(t)
		for _, element := range []struct{ name, item string }{{"core.brand", ""}, {"core.space-tab.add", ""}} {
			f.run("core.card.focus", map[string]string{"card": f.tabbedCards()[0]})
			pressElement(f, "core.card.header", f.tabbedCards()[0])
			f.tester.Release(0, 0)
			f.settle()
			pressElement(f, element.name, element.item)
			if got := textScope(t, f); got != workbench.FrameScope() {
				t.Fatalf("after the press on %s the scope is %+v", element.name, got)
			}
			f.tester.Move(0, 0)
			f.tester.Release(0, 0)
			f.settle()
		}
		f.run("core.text.larger", nil)
		f.settle()
		var text struct {
			Frame float64            `json:"frame"`
			Cards map[string]float64 `json:"cards"`
		}
		if err := json.Unmarshal([]byte(f.status("core.text")), &text); err != nil {
			t.Fatal(err)
		}
		if text.Frame == 1 {
			t.Fatalf("the text size of the frame stays %v", text.Frame)
		}
		for id, factor := range text.Cards {
			if factor != 1 {
				t.Fatalf("the press on the frame changed the card %s to %v", id, factor)
			}
		}
	})
	t.Run("a watcher", func(t *testing.T) {
		f, stored := surfaceShell(t)
		cards := f.tabbedCards()
		f.run("core.card.focus", map[string]string{"card": cards[0]})
		f.settle()
		var surface string
		for id, placed := range stored.lastSurfaces(t) {
			if placed["visible"] == true && f.cardOfTab(id) == cards[1] {
				surface = id
			}
		}
		leaveForTheFrame(t, f)
		var seen workbench.TextStatus
		watch := json.RawMessage(`{"name":"core.text"}`)
		if _, err := f.shell.Registry().Answer("status.watch", watch, func(_ string, value any) { seen = value.(workbench.TextStatus) }); err != nil {
			t.Fatal(err)
		}
		f.shell.Event("surface-pressed", []any{surface})
		f.settle()
		if seen.Scope != card(cards[1]) {
			t.Fatalf("the watcher last saw the scope %+v", seen.Scope)
		}
	})
	t.Run("focus without a press", func(t *testing.T) {
		f, _ := surfaceShell(t)
		cards := f.tabbedCards()
		pressElement(f, "core.card.header", cards[1])
		f.run("core.card.focus", map[string]string{"card": cards[0]})
		f.settle()
		if got := textScope(t, f); got != card(cards[1]) {
			t.Fatalf("a focus without a press moved the scope to %+v", got)
		}
	})
}

// cardOfTab returns the card that holds the tab.
func (f *shellFixture) cardOfTab(tab string) string {
	f.t.Helper()
	for _, stored := range f.cardsOf() {
		data, _ := stored["data"].(map[string]any) // silent: a card without data holds no tab.
		tabs, _ := data["tabs"].([]any)
		for _, item := range tabs {
			if item.(map[string]any)["id"] == tab {
				return stored["id"].(string)
			}
		}
	}
	return ""
}

// textFactors returns the card factors of the status core.text.
func textFactors(t *testing.T, f *shellFixture) map[string]float64 {
	t.Helper()
	var text struct {
		Cards map[string]float64 `json:"cards"`
	}
	if err := json.Unmarshal([]byte(f.status("core.text")), &text); err != nil {
		t.Fatal(err)
	}
	return text.Cards
}

// pressCardHead presses the head of a card and releases it.
func pressCardHead(f *shellFixture, card string) {
	f.t.Helper()
	pressElement(f, "core.card.header", card)
	f.tester.Release(0, 0)
	f.settle()
}

// A pressed card that closes leaves the scope to the focused card, which the next change of the text size changes.
func TestAClosedCardGivesTheTextScopeToTheFocusedCard(t *testing.T) {
	f, _ := surfaceShell(t)
	cards := f.tabbedCards()
	pressCardHead(f, cards[1])
	if _, err := f.answer("core.card.close", map[string]string{"card": cards[1]}); err != nil {
		t.Fatal(err)
	}
	f.settle()
	if got := textScope(t, f); got != workbench.CardScope(cards[0]) {
		t.Fatalf("the scope is %+v", got)
	}
	if _, err := f.answer("core.text.larger", nil); err != nil {
		t.Fatal(err)
	}
	f.settle()
	if got := textFactors(t, f)[cards[0]]; got == 1 {
		t.Fatalf("the focused card keeps the factor %v", got)
	}
}

// A press on a card does not reach the card of the same id of another space.
func TestAnotherSpaceDoesNotTakeThePressOfACard(t *testing.T) {
	f, _ := surfaceShell(t)
	cards := f.tabbedCards()
	pressCardHead(f, cards[1])
	f.run("core.space.add", nil)
	f.settle()
	focused := focusedCards(t, f)
	if len(focused) != 1 || focused[0] == cards[1] {
		t.Fatalf("the new space focuses %v, which does not tell the scope from the press", focused)
	}
	if got := textScope(t, f); got != workbench.CardScope(focused[0]) {
		t.Fatalf("the scope is %+v", got)
	}
	f.run("core.text.larger", nil)
	f.settle()
	factors := textFactors(t, f)
	if factors[cards[1]] != 1 || factors[focused[0]] == 1 {
		t.Fatalf("the change left the factors %v", factors)
	}
}

// The library shows no card, so a press on a card does not stay the scope behind it.
func TestTheLibraryDoesNotKeepThePressOfACard(t *testing.T) {
	f, _ := surfaceShell(t)
	cards := f.tabbedCards()
	pressCardHead(f, cards[1])
	f.run("core.projects.browse", nil)
	f.settle()
	if got := textScope(t, f); got != workbench.FrameScope() {
		t.Fatalf("the scope is %+v", got)
	}
}

// A press on the frame stays the scope in another space: it is the place pressed last, and the frame does not leave.
func TestAnotherSpaceKeepsThePressOfTheFrame(t *testing.T) {
	f, _ := surfaceShell(t)
	pressElement(f, "core.brand", "")
	f.tester.Release(0, 0)
	f.settle()
	f.run("core.space.add", nil)
	f.settle()
	if got := textScope(t, f); got != workbench.FrameScope() {
		t.Fatalf("the scope is %+v", got)
	}
}

// A space that shows again is the same space: its cards are the ones pressed.
func TestTheSameSpaceKeepsThePressOfACard(t *testing.T) {
	f, _ := surfaceShell(t)
	cards := f.tabbedCards()
	pressCardHead(f, cards[1])
	f.run("core.card.focus", map[string]string{"card": cards[0]})
	f.settle()
	var project struct {
		ActiveSpaceID string `json:"activeSpaceId"`
	}
	if err := json.Unmarshal([]byte(f.status("core.project")), &project); err != nil {
		t.Fatal(err)
	}
	if project.ActiveSpaceID == "" {
		t.Fatalf("no active space in %s", f.status("core.project"))
	}
	f.run("core.space.activate", map[string]string{"id": project.ActiveSpaceID})
	f.settle()
	if got := textScope(t, f); got != workbench.CardScope(cards[1]) {
		t.Fatalf("the scope is %+v", got)
	}
}

// The error of an operation of the active tab is shown in its card's status row through the error display, which records
// `tab error <tab>: <text>` when the text appears and again after it was removed (docs/spec/plugins.md#tab-reports).
func TestTheErrorOfTheActiveTabIsRecordedWhenItAppears(t *testing.T) {
	f, stored := surfaceShell(t)
	surface := terminalSurface(t, stored)
	want := []shownRecord{{"tab error " + surface, "late"}}
	if got := viewCallShowing(t, f, stored, surface, "tab.error", "late"); !slices.Equal(got, want) {
		t.Fatalf("the records of the shown error are %q", got)
	}
	// The same text in later frames records nothing; the text after its removal is recorded again.
	if got := viewCallShowing(t, f, stored, surface, "tab.error", "late"); len(got) != 0 {
		t.Fatalf("the same error was recorded again: %q", got)
	}
	if got := viewCallShowing(t, f, stored, surface, "tab.error", nil); len(got) != 0 {
		t.Fatalf("the removal of the error was recorded: %q", got)
	}
	if got := viewCallShowing(t, f, stored, surface, "tab.error", "late"); !slices.Equal(got, want) {
		t.Fatalf("the records of the error shown again are %q", got)
	}
}

// The declaration names the native frame, whose edges share the device grid
// with the painted card chrome; the stored plane may remain fractional.
func TestSurfaceDeclarationsUseTheFrameBackingPixelEdges(t *testing.T) {
	for _, scale := range []float64{1, 2} {
		t.Run(fmt.Sprint(scale), func(t *testing.T) {
			f, stored := surfaceShell(t)
			stored.window.Scale = scale
			stored.elements = true
			f.tester.SetScale(float32(scale))
			f.run("core.card.focus", map[string]string{"card": f.tabbedCards()[0]})
			f.settle()
			rows := status[[]struct {
				Surface  string                       `json:"surface"`
				Visible  bool                         `json:"visible"`
				Declared struct{ X, Y, W, H float64 } `json:"declared"`
			}](t, f, "core.surfaces")
			requests := stored.lastSurfaces(t)
			checked := 0
			for _, row := range rows {
				if !row.Visible {
					continue
				}
				checked++
				box := row.Declared
				for _, edge := range []float64{box.X, box.Y, box.X + box.W, box.Y + box.H} {
					if edge*scale != math.Round(edge*scale) {
						t.Errorf("surface %s declares an edge outside its actual backing-pixel grid: edge=%v scale=%v frame=%+v", row.Surface, edge, scale, box)
					}
				}
				request := requests[row.Surface]
				for key, expected := range map[string]float64{"x": box.X, "y": box.Y, "w": box.W, "h": box.H} {
					if request[key] != expected {
						t.Errorf("surface %s status and host declaration differ at %s: %v versus %v", row.Surface, key, expected, request[key])
					}
				}
			}
			if checked == 0 {
				t.Fatal("no visible native surface declaration was checked")
			}
		})
	}
}

func TestSurfaceStatusExposesOnlyTheDeclaredCompositionKind(t *testing.T) {
	var document struct {
		Plugins []map[string]any `json:"plugins"`
	}
	if err := json.Unmarshal([]byte(installedDocument), &document); err != nil {
		t.Fatal(err)
	}
	document.Plugins = append(document.Plugins, map[string]any{"id": "no-view", "package": "@scope/plugin-no-view", "version": "1.0.0",
		"manifest": map[string]any{"id": "no-view", "name": "No view", "description": "No surface declaration", "contributes": map[string]any{}, "mark": "n", "icon": "<path d=\"M1 1h14\"/>"}})
	encoded, err := json.Marshal(document)
	if err != nil {
		t.Fatal(err)
	}
	f, _ := surfaceShellOf(t, string(encoded))
	rows := status[[]map[string]any](t, f, "core.surfaces")
	checkedView := false
	for _, row := range rows {
		switch row["plugin"] {
		case "boxprobe":
			checkedView = true
			if row["composition"] != "view" {
				t.Errorf("public composition must be the declared kind string, not renderer configuration: %v", row)
			}
		case "no-view":
			t.Errorf("a contribution-only plugin has no mounted surface row: %v", row)
		}
	}
	if !checkedView {
		t.Fatalf("fixture must cover a view composition: %v", rows)
	}
	checkedAbsent := false
	for _, plugin := range f.pluginStatus().Plugins {
		if plugin.ID == "no-view" {
			checkedAbsent = true
			if plugin.Composition != nil {
				t.Errorf("the actual contribution-only plugin must expose null composition: %+v", plugin)
			}
		}
	}
	if !checkedAbsent {
		t.Fatal("the valid contribution-only plugin is absent from public plugin status")
	}
}

func TestSurfaceDeclarationsShareOneWindowObservationPerView(t *testing.T) {
	f, stored := surfaceShell(t)
	stored.elements = true
	stored.viewWindowReads = nil
	f.tester.Frame()
	f.settle()
	if len(stored.lastSurfaces(t)) < 2 {
		t.Fatal("the read-budget fixture needs multiple real surface declarations")
	}
	if len(stored.viewWindowReads) == 0 {
		t.Fatal("no actual public Shell.View build was observed")
	}
	for index, reads := range stored.viewWindowReads {
		if reads != 1 {
			t.Errorf("view build %d read the native WindowView port %d times, expected one shared frame-owned observation", index, reads)
		}
	}
}

// core.library.open answers once the window shows the project again and the host presented its surfaces: the opening reads the
// geometry store first, so a command that answered at the end of its run would answer while the window still shows the library.
// A check that reads host.window after the answer finds the views of the project where the frame stands them.
func TestAProjectReturnAnswersWhenItsSurfacesArePresented(t *testing.T) {
	f, stored := surfaceShell(t)
	surface := anySurface(t, stored)
	f.run("core.projects.browse", struct{}{})
	if stored.lastSurfaces(t)[surface]["visible"] != false {
		t.Fatalf("the library shows the surface: %v", stored.lastSurfaces(t)[surface])
	}
	raw, err := json.Marshal(map[string]string{"id": f.host.projects[0]["id"].(string)})
	if err != nil {
		t.Fatal(err)
	}
	answered, visible, presented := false, any(nil), false
	f.shell.Registry().RunLater("core.library.open", raw, func(_ any, err error) {
		if err != nil {
			t.Errorf("core.library.open: %v", err)
		}
		answered, visible = true, stored.lastSurfaces(t)[surface]["visible"]
		presented = stored.placed == len(stored.requests)
	})
	f.settle()
	if !answered || visible != true || !presented {
		t.Fatalf("core.library.open answered %t with the surface visible %v and its placement presented %t", answered, visible, presented)
	}
}

// Each placement gives the host the height of the first row that its frame draws, round(max(40, 36 × frame factor)), as the page
// gives it with each preparation (frameLayout of packages/workbench/frame-text.js), so the window buttons move with the row that
// shows them. A change of the factor alone places again, with no surface, as on the library screen.
func TestEachPlacementGivesTheFirstRowOfItsFrame(t *testing.T) {
	f, stored := surfaceShell(t)
	titlebar := func() float64 {
		t.Helper()
		if len(stored.requests) == 0 {
			t.Fatal("the workbench placed nothing")
		}
		value, _ := stored.requests[len(stored.requests)-1]["titlebar"].(float64)
		return value
	}
	if got := titlebar(); got != 40 {
		t.Fatalf("the first row at factor 1 is %v, want 40", got)
	}
	for _, step := range []struct{ factor, row float64 }{{2, 72}, {1.25, 45}} {
		f.run("core.settings.set", map[string]any{"patch": map[string]any{"textSize": step.factor}, "scope": "common"})
		f.settle()
		if got := titlebar(); got != step.row {
			t.Fatalf("the placement at factor %v gives the first row %v, want %v", step.factor, got, step.row)
		}
	}
	f.run("core.projects.browse", nil)
	f.settle()
	f.run("core.settings.set", map[string]any{"patch": map[string]any{"textSize": 3}, "scope": "common"})
	f.settle()
	if got := titlebar(); got != 108 {
		t.Fatalf("the library at factor 3 gives the first row %v, want 108", got)
	}
}

// A placement that the answer of a running placement makes, outside a frame, places the lines of the frame that drew them, and so
// gives the first row of that frame: the host sets the title bar in the layout transaction that frame opened, which commits it with
// the frame. A frame factor that changed after the frame shows with the next frame, which places its own row.
func TestAPlacementAtTheAnswerGivesTheFirstRowItsFrameDrew(t *testing.T) {
	f, stored := surfaceShell(t)
	gate := make(chan struct{})
	stored.orderMu.Lock()
	stored.presentGate = gate
	stored.orderMu.Unlock()
	f.tester.SetSize(1100, 800)
	f.tester.Frame()
	f.pending.drain(t)
	requests := len(stored.requests)
	f.tester.SetSize(1000, 800)
	f.tester.Frame()
	f.pending.drain(t)
	raw, err := json.Marshal(map[string]any{"patch": map[string]any{"textSize": 2}, "scope": "common"})
	if err != nil {
		t.Fatal(err)
	}
	// The command answers once a frame placed the change, so the answer comes after the frame that draws it.
	f.shell.Registry().RunLater("core.settings.set", raw, func(_ any, err error) {
		if err != nil {
			t.Errorf("core.settings.set: %v", err)
		}
	})
	f.pending.drain(t)
	if status, err := f.shell.Registry().Read("core.text"); err != nil || status.(workbench.TextStatus).Frame != 2 {
		t.Fatalf("the frame factor did not change before the answer of the running placement: %v %v", status, err)
	}
	stored.orderMu.Lock()
	stored.presentGate = nil
	stored.orderMu.Unlock()
	close(gate)
	f.pending.drain(t)
	if got := len(stored.requests); got != requests+1 {
		t.Fatalf("the answer of the running placement made %d placements without a frame, want 1", got-requests)
	}
	if got, _ := stored.requests[len(stored.requests)-1]["titlebar"].(float64); got != 40 {
		t.Fatalf("the placement of the frame that drew the first row 40 gives the first row %v", got)
	}
	f.settle()
	if got, _ := stored.requests[len(stored.requests)-1]["titlebar"].(float64); got != 72 {
		t.Fatalf("the frame that drew the frame factor 2 gives the first row %v, want 72", got)
	}
}

// A restarted workbench shows its first screen over the last frame of the workbench before it, which the window holds until then, and
// the title bar keeps the row of that frame: the row of its settings goes to the window with the layout of its first screen, also on
// the library, which places no surface. A window whose title bar already has that row, as a new window, places nothing for it.
func TestTheFirstScreenGivesItsRowToAWindowWithAnotherTitleBar(t *testing.T) {
	for _, held := range []struct {
		titlebar float64
		places   bool
	}{{40, true}, {72, false}} {
		stored := &surfaceHost{storedHost: storedHost{common: map[string]any{"textSize": 2.0}, titlebar: held.titlebar}}
		surfaceShellOn(t, installedDocument, stored)
		if len(stored.requests) == 0 {
			t.Fatalf("the workbench over the title bar %v placed nothing", held.titlebar)
		}
		first := stored.requests[0]
		surfaces, _ := first["surfaces"].([]any)
		library := len(surfaces) == 0
		if library != held.places || first["titlebar"] != 72.0 {
			t.Fatalf("over the title bar %v the first placement gives the first row %v for the library %t, want the row 72 placed for the library %t",
				held.titlebar, first["titlebar"], library, held.places)
		}
	}
}

// callsSince returns the host calls made after the first count calls.
func (h *surfaceHost) callsSince(count int) []string {
	h.orderMu.Lock()
	defer h.orderMu.Unlock()
	return slices.Clone(h.order[count:])
}

// openings returns the number of layouts that frames opened.
func (h *surfaceHost) openings() int {
	h.orderMu.Lock()
	defer h.orderMu.Unlock()
	return len(h.opened)
}

// callCount returns the number of host calls so far.
func (h *surfaceHost) callCount() int {
	h.orderMu.Lock()
	defer h.orderMu.Unlock()
	return len(h.order)
}

// A frame that moves a surface sets the frame of its surface host in its own Core Animation transaction, so it opens the layout
// transaction of the window before it presents, and the placement of its lines takes that transaction over: the frame shows with the
// commit, after the image regions present the raster of the new size (docs/spec/native-surfaces.md#regions).
func TestAFrameThatMovesASurfaceOpensTheLayoutBeforeItsPlacement(t *testing.T) {
	f, stored := surfaceShell(t)
	before, opened := stored.callCount(), stored.openings()
	f.tester.SetSize(1100, 800)
	f.tester.Frame()
	if at := stored.openedAt[opened:]; !slices.Equal(at, []int{before}) {
		t.Fatalf("the frame that moved the surfaces opened the layout after the host calls %v, want one opening after %d", at, before)
	}
	f.pending.drain(t)
	calls := stored.callsSince(before)
	if want := []string{"syncSurfaces", "presentSurfaces"}; !slices.Equal(calls, want) {
		t.Fatalf("the placement of the moved surfaces made the host calls %q, want %q", calls, want)
	}
	// A frame that a layout transaction holds draws inside it and opens none.
	stored.transaction = true
	before, opened = stored.callCount(), stored.openings()
	f.tester.SetSize(1000, 800)
	f.tester.Frame()
	f.pending.drain(t)
	if calls := stored.callsSince(before); stored.openings() != opened || !slices.Contains(calls, "syncSurfaces") {
		t.Fatalf("a frame inside a layout transaction opened %d layouts with the host calls %q", stored.openings()-opened, calls)
	}
}

// A frame that moves a surface while a placement runs opens the layout transaction, which holds the frames of the window, so the
// answer of the running placement places the lines of that frame at once instead of waiting for a frame that the transaction holds.
func TestAFrameThatMovesASurfaceDuringAPlacementIsPlacedAtItsAnswer(t *testing.T) {
	f, stored := surfaceShell(t)
	gate := make(chan struct{})
	stored.orderMu.Lock()
	stored.presentGate = gate
	stored.orderMu.Unlock()
	f.tester.SetSize(1100, 800)
	f.tester.Frame()
	f.pending.drain(t)
	requests := len(stored.requests)
	before, opened := stored.callCount(), stored.openings()
	f.tester.SetSize(1000, 800)
	f.tester.Frame()
	f.pending.drain(t)
	if calls := stored.callsSince(before); len(calls) != 0 || stored.openings() != opened+1 {
		t.Fatalf("a frame that moved the surfaces during a placement opened %d layouts with the host calls %q",
			stored.openings()-opened, calls)
	}
	stored.orderMu.Lock()
	stored.presentGate = nil
	stored.orderMu.Unlock()
	close(gate)
	f.pending.drain(t)
	if got := len(stored.requests); got != requests+1 {
		t.Fatalf("the answer of the running placement made %d placements without a frame, want 1", got-requests)
	}
	if calls := stored.callsSince(before); slices.Contains(calls, "cancelSurfaces") {
		t.Fatalf("the placement that took the opened layout over made the host calls %q", calls)
	}
}

// A placement whose preparation fails leaves the layout that its frame opened to no preparation, so the host cancels that layout,
// which commits it and releases the frames of the window, and the next frame that moves a surface opens and places again.
func TestAPlacementThatFailsBeforeItsPreparationCancelsTheOpenedLayout(t *testing.T) {
	f, stored := surfaceShell(t)
	stored.syncFailure = errors.New("refused")
	f.tester.SetSize(1100, 800)
	f.tester.Frame()
	f.pending.drain(t)
	stored.orderMu.Lock()
	opened, cancelled := slices.Clone(stored.opened), slices.Clone(stored.cancelled)
	stored.orderMu.Unlock()
	if len(opened) == 0 || !slices.Equal(cancelled, opened[len(opened)-1:]) {
		t.Fatalf("a failed preparation cancelled the layouts %v after the frame opened %v", cancelled, opened)
	}
	stored.syncFailure = nil
	requests := len(stored.requests)
	f.tester.SetSize(1000, 800)
	f.tester.Frame()
	f.pending.drain(t)
	if len(stored.requests) != requests+1 || stored.pending != 0 {
		t.Fatalf("after the failure the next frame made %d placements and left the layout %d open", len(stored.requests)-requests, stored.pending)
	}
}

// A frame that opens the layout of its window and makes no preparation, as a frame whose placement fails by a layout fault, cancels
// the layout before it ends, so the layout does not hold the next frame, which opens and places again (docs/spec/hosts.md#native-views).
func TestAFrameThatOpensTheLayoutWithoutAPreparationDoesNotHoldTheNext(t *testing.T) {
	f, stored := surfaceShell(t)
	f.shell.Registry().Reply("diagnostics.layout.fail", json.RawMessage(`{}`), nil, func(any, error) {})
	f.settle()
	opened := stored.openings()
	f.tester.SetSize(1100, 800)
	f.tester.Frame()
	f.pending.drain(t)
	stored.orderMu.Lock()
	ended, cancelled, pending := slices.Clone(stored.opened[opened:]), slices.Clone(stored.cancelled), stored.pending
	stored.orderMu.Unlock()
	if len(ended) == 0 || !slices.Contains(cancelled, ended[0]) || pending != 0 {
		t.Fatalf("the faulted frame opened %v and cancelled %v, leaving %d open", ended, cancelled, pending)
	}
	requests := len(stored.requests)
	f.tester.SetSize(1000, 800)
	f.tester.Frame()
	f.pending.drain(t)
	if len(stored.requests) != requests+1 || stored.pending != 0 {
		t.Fatalf("the frame after the fault made %d placements, leaving %d open", len(stored.requests)-requests, stored.pending)
	}
}
