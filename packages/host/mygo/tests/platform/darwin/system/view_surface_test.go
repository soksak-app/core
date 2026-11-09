//go:build darwin && e2e

package system_test

// Checks the view surfaces of a window of the mygo host through the host calls of the workbench: a view page in a surface host of the
// native view of the window, the end of its process and its keyboard (docs/spec/hosts.md#native-views). The tests share one host
// session, and each test removes its surfaces, because the window of the session lives as long as the process. A frame and a page
// need a display, so these tests carry the build constraint e2e (docs/operations/examples.md#test-kinds).

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"slices"
	"sort"
	"strings"
	"sync"
	"sync/atomic"
	"syscall"
	"testing"
	"testing/fstest"
	"time"
	"unsafe"

	"github.com/egoist/mygo"
	"github.com/egoist/mygo/ui"

	host "github.com/soksak-app/core/packages/host/go/src"
	"github.com/soksak-app/core/packages/host/go/src/platform"
	adapter "github.com/soksak-app/core/packages/host/mygo/src"
	"github.com/soksak-app/core/packages/host/mygo/tests/platform/darwin"
	"github.com/soksak-app/core/packages/host/mygo/tests/support"
)

// box is where a card shows the surface of a test.
var box = platform.Rect{X: 30, Y: 40, W: 300, H: 200}

// elementWorkbench draws one card for each listed surface, as the workbench of the application does.
type elementWorkbench struct {
	support.SceneWorkbench
	host    atomic.Pointer[host.Host]
	context atomic.Pointer[context.Context]
	shown   atomic.Pointer[[]string]
	// started receives the result of the ready report of the first start of the workbench.
	started   chan error
	startOnce sync.Once
}

// Shown answers as the workbench of the application does: it reports that the workbench of the window is ready and shows its first
// screen, which puts a new window on the screen and releases the frames that a restart of the workbench holds.
func (w *elementWorkbench) Shown(window host.Frontend) {
	w.Record("shown %s", window.Name())
	err := w.host.Load().WindowReady(*w.context.Load())
	if err != nil {
		w.Record("ready failed: %v", err)
	}
	mygo.RunOnMain(window.(*adapter.Frontend).FirstScreen)
	w.startOnce.Do(func() { w.started <- err })
}

// Emit answers each request of the host with an empty result, as a workbench that has nothing to save.
func (w *elementWorkbench) Emit(window host.Frontend, name string, data ...any) {
	if name != "exposure-request" {
		return
	}
	encoded, err := json.Marshal(data[0])
	if err != nil {
		panic(err)
	}
	var request struct {
		ID uint64 `json:"id"`
	}
	if err := json.Unmarshal(encoded, &request); err != nil {
		panic(err)
	}
	go func() {
		reply, _ := json.Marshal(map[string]any{"id": request.ID, "result": nil})
		if err := w.host.Load().ExposureReply(*w.context.Load(), reply); err != nil {
			w.Record("reply failed: %v", err)
		}
	}()
}

func (w *elementWorkbench) Build(window host.Frontend) func(c *ui.Context) {
	ctx := host.WithFrontend(context.Background(), window)
	w.context.Store(&ctx)
	w.Record("build %s", window.Name())
	return func(c *ui.Context) {
		shown := w.shown.Load()
		if shown == nil {
			return
		}
		for _, id := range *shown {
			if element, ok := host.ElementOf(w.host.Load(), window, id); ok {
				ui.NativeView(c, uintptr(element.Surface), uintptr(element.Key)).Absolute().Left(float32(box.X)).Top(float32(box.Y)).Size(float32(box.W), float32(box.H))
			}
		}
	}
}

// viewSession is the host session of the tests, with its only window.
type viewSession struct {
	// config is the configuration folder of the session, whose logs hold the event log of the host.
	config    string
	host      *host.Host
	workbench *elementWorkbench
	window    *adapter.Frontend
	system    platform.Platform
}

var (
	session     *viewSession
	sessionOnce sync.Once
	sessionErr  error
)

// startViewSession prepares the host with one installed plugin whose view page fills its surface, and opens the window.
func startViewSession() (*viewSession, error) {
	config, err := os.MkdirTemp("", "soksak-mygo-view")
	if err != nil {
		return nil, err
	}
	cleanup = func() { os.RemoveAll(config) }
	folder := filepath.Join(config, "plugins", "probe", "0.2.0")
	files := map[string]string{
		filepath.Join(config, "plugins", "installed.json"): `{"format": 3, "plugins": {"probe": {"version": "0.2.0", "path": "plugins/probe/0.2.0",
			"enabled": true, "sidecars": {}}}, "sidecars": {}}`,
		filepath.Join(folder, "package.json"): `{"name": "@scope/plugin-probe", "version": "0.2.0", "engines": {"soksak": "*"}}`,
		filepath.Join(folder, "plugin.json"):  `{"id": "probe", "name": "Probe", "description": "Sample."}`,
		filepath.Join(folder, "ui/page.html"): `<!doctype html><title>view</title><body style="background: #204080"><input autofocus>`,
	}
	for path, text := range files {
		if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
			return nil, err
		}
		if err := os.WriteFile(path, []byte(text), 0o644); err != nil {
			return nil, err
		}
	}
	system, err := platform.Current()
	if err != nil {
		return nil, err
	}
	assets := fstest.MapFS{
		"frontend/core-root.json":                           {Data: []byte("[]")},
		"frontend/view-imports.json":                        {Data: []byte(`{"imports":{}}`)},
		"frontend/modules/@soksak/plugin-api/view-start.js": {Data: []byte("")},
	}
	workbench := &elementWorkbench{started: make(chan error, 1)}
	framework := adapter.NewFramework(workbench)
	// The host prepares on the main thread, as Run does before the application runs.
	var opened *host.Session
	mygo.RunOnMain(func() { opened, err = host.Prepare(framework, assets, host.Options{ConfigDir: config}) })
	if err != nil {
		return nil, err
	}
	workbench.host.Store(opened.Host())
	framework.Serve(opened.Host())
	if err := framework.ObserveLayout(); err != nil {
		return nil, err
	}
	if err := opened.Open(); err != nil {
		return nil, err
	}
	windows := framework.Windows()
	if len(windows) != 1 {
		return nil, fmt.Errorf("the session opened %d windows", len(windows))
	}
	window := windows[0].(*adapter.Frontend)
	window.Show()
	// The workbench starts once the window drew its first frame and showed, and the start of a page ends the composition
	// declarations and the surface preparations of the page before it. The workbench of the application makes its host calls only
	// after its start, so the session waits for it before a test makes host calls.
	select {
	case err := <-workbench.started:
		if err != nil {
			return nil, fmt.Errorf("the workbench did not report that it is ready: %w", err)
		}
	case <-time.After(10 * time.Second):
		return nil, fmt.Errorf("the workbench did not start within 10 s: %v", workbench.Received())
	}
	return &viewSession{config: config, host: opened.Host(), workbench: workbench, window: window, system: system}, nil
}

// viewHost returns the shared session.
func viewHost(t *testing.T) *viewSession {
	t.Helper()
	sessionOnce.Do(func() { session, sessionErr = startViewSession() })
	if sessionErr != nil {
		t.Fatal(sessionErr)
	}
	return session
}

// layout runs one layout transaction of the window that shows the surfaces with their visibility, in the host calls of the workbench.
func (s *viewSession) layout(t *testing.T, surfaces ...host.Surface) []host.Placement {
	t.Helper()
	ctx := *s.workbench.context.Load()
	shown := make([]string, 0, len(surfaces))
	wire := make([]map[string]any, 0, len(surfaces))
	declarations := make([]map[string]any, 0, len(surfaces))
	for index, surface := range surfaces {
		wire = append(wire, map[string]any{
			"id": surface.ID, "visible": surface.Visible, "dim": false, "plugin": surface.Plugin, "composition": surface.Composition,
			"x": surface.X, "y": surface.Y, "w": surface.W, "h": surface.H,
			"start": map[string]any{"declarations": index, "origin": map[string]any{"directory": nil}, "diagnostics": nil, "section": nil},
		})
		declarations = append(declarations, map[string]any{})
		declared, err := json.Marshal(host.CompositionDeclareRequest{Surface: surface.ID, Plugin: surface.Plugin, Composition: surface.Composition})
		if err != nil {
			t.Fatal(err)
		}
		if err := s.host.CompositionDeclare(ctx, declared); err != nil {
			t.Fatal(err)
		}
		if surface.Visible {
			shown = append(shown, surface.ID)
		}
	}
	request, err := json.Marshal(map[string]any{"settled": true, "surfaces": wire, "declarations": declarations, "titlebar": 36})
	if err != nil {
		t.Fatal(err)
	}
	prepared, err := s.host.SyncSurfaces(ctx, request)
	if err != nil {
		t.Fatal(err)
	}
	s.workbench.shown.Store(&shown)
	s.window.Window().Invalidate()
	present, err := json.Marshal(host.PresentRequest{Ticket: prepared.Ticket, Placements: prepared.Placements, Settled: true})
	if err != nil {
		t.Fatal(err)
	}
	placed, err := s.host.PresentSurfaces(ctx, present)
	if err != nil {
		t.Fatal(err)
	}
	return placed
}

// viewSurface is a view surface of the installed plugin, in the box of the card.
func viewSurface(id string, visible bool) host.Surface {
	return host.Surface{ID: id, Visible: visible, Plugin: "probe", Rect: host.Rect(box),
		Composition: host.SurfaceComposition{Kind: "view", Page: "ui/page.html"}}
}

// viewRow is the row of a web view of the facts of a window.
type viewRow struct {
	View    uint64  `json:"view"`
	X       float64 `json:"x"`
	Y       float64 `json:"y"`
	Width   float64 `json:"width"`
	Height  float64 `json:"height"`
	Hidden  bool    `json:"hidden"`
	Focused bool    `json:"focused"`
	Process int32   `json:"process"`
	// Document marks the view of a document region.
	Document bool `json:"document"`
}

// row returns the row of the view page of the surface id.
func (s *viewSession) row(t *testing.T, id string) viewRow {
	t.Helper()
	element, ok := host.ElementOf(s.host, s.window, id)
	if !ok {
		t.Fatalf("surface %s has no element", id)
	}
	rows := s.rows(t)
	index := slices.IndexFunc(rows, func(row viewRow) bool { return uintptr(row.View) == uintptr(element.Key) })
	if index < 0 {
		t.Fatalf("the view page of surface %s is not in the native view of the window: %+v", id, rows)
	}
	return rows[index]
}

// rows returns the web views in the native view of the window.
func (s *viewSession) rows(t *testing.T) []viewRow {
	t.Helper()
	var text string
	var err error
	mygo.RunOnMain(func() { text, err = s.system.WindowFacts(s.window.NativeWindow()) })
	if err != nil {
		t.Fatal(err)
	}
	var facts struct {
		Webviews []viewRow `json:"webviews"`
	}
	if err := json.Unmarshal([]byte(text), &facts); err != nil {
		t.Fatal(err)
	}
	return facts.Webviews
}

// A view page shows in its surface host, which the native view element of its card places in the frame of the card.
func TestE2EAViewPageShowsInASurfaceHostOfTheNativeView(t *testing.T) {
	session := viewHost(t)
	t.Cleanup(func() { session.layout(t) })
	placed := session.layout(t, viewSurface("shown", true))
	if len(placed) != 1 || placed[0].Rect != host.Rect(box) {
		t.Fatalf("the surface is placed at %+v", placed)
	}
	if got := session.window.Frames().NativeViews(); got != 1 {
		t.Fatalf("the window holds %d native view elements, want the 1 that it placed", got)
	}
	row := session.row(t, "shown")
	if row.Hidden || row.X != box.X || row.Y != box.Y || row.Width != box.W || row.Height != box.H {
		t.Fatalf("the view page shows in %+v", row)
	}
}

// Closing the last view ends its process.
func TestE2EClosingTheLastViewEndsItsProcess(t *testing.T) {
	session := viewHost(t)
	session.layout(t, viewSurface("last", true))
	var process int32
	support.Wait(t, "the process of the view", func() bool {
		process = session.row(t, "last").Process
		return process != 0
	})
	session.layout(t)
	support.Wait(t, "the end of the process of the last view", func() bool {
		return errors.Is(syscall.Kill(int(process), 0), syscall.ESRCH)
	})
}

// A view page that holds the keyboard holds it again after a layout transaction hides and shows its surface.
func TestE2EAViewPageHoldsTheKeyboardAgainAfterItsSurfaceHidAndShowed(t *testing.T) {
	session := viewHost(t)
	t.Cleanup(func() { session.layout(t) })
	session.layout(t, viewSurface("keyboard", true))
	element, _ := host.ElementOf(session.host, session.window, "keyboard")
	session.window.Window().Focus()
	mygo.RunOnMain(func() { session.system.FocusModal(unsafe.Pointer(element.Key), true) })
	support.Wait(t, "the keyboard in the view page", func() bool { return session.row(t, "keyboard").Focused })
	session.layout(t, viewSurface("keyboard", false))
	if session.row(t, "keyboard").Focused {
		t.Fatal("the hidden view page holds the keyboard")
	}
	session.layout(t, viewSurface("keyboard", true))
	if !session.row(t, "keyboard").Focused {
		t.Fatal("the view page did not hold the keyboard again")
	}
}

// hostEvents returns the events that the host wrote to the event log of the session, its debug file with them, in the order of their
// sequence.
func (s *viewSession) hostEvents() ([]map[string]any, error) {
	if err := host.FlushRecords(2 * time.Second); err != nil {
		return nil, err
	}
	paths, err := filepath.Glob(filepath.Join(s.config, "logs", "host-*.jsonl"))
	if err != nil {
		return nil, err
	}
	var events []map[string]any
	for _, path := range paths {
		data, err := os.ReadFile(path)
		if err != nil {
			return nil, err
		}
		for _, line := range strings.Split(strings.TrimSuffix(string(data), "\n"), "\n") {
			if line == "" {
				continue
			}
			var event map[string]any
			if err := json.Unmarshal([]byte(line), &event); err != nil {
				return nil, fmt.Errorf("%s: %w", path, err)
			}
			events = append(events, event)
		}
	}
	sort.SliceStable(events, func(i, j int) bool { return sequence(events[i]) < sequence(events[j]) })
	return events, nil
}

// sequence is the sequence number of an event of the event log.
func sequence(event map[string]any) float64 {
	seq, _ := event["seq"].(float64) // silent: an event without a number sorts first, and the log shows it whole.
	return seq
}

// logOnFailure makes a test that fails write what happened while it ran: the records of the fixture workbench and the events of the
// host, among them its error records and the events of the window, since the call.
func (s *viewSession) logOnFailure(t *testing.T) {
	t.Helper()
	mark := -1.0
	if events, err := s.hostEvents(); err != nil {
		t.Logf("the host events before the test cannot be read: %v", err)
	} else if len(events) > 0 {
		mark = sequence(events[len(events)-1])
	}
	received := len(s.workbench.Received())
	t.Cleanup(func() {
		if !t.Failed() {
			return
		}
		t.Logf("workbench records: %q", s.workbench.Received()[received:])
		// The standard error and crash files of the host, as the application tests of this package write them.
		if logged := support.Logged(s.config); logged != "" {
			t.Logf("host log files:\n%s", logged)
		}
		events, err := s.hostEvents()
		if err != nil {
			t.Logf("the host events cannot be read: %v", err)
			return
		}
		for _, event := range events {
			if sequence(event) <= mark {
				continue
			}
			line, err := json.Marshal(event)
			if err != nil {
				t.Logf("host event %v: %v", event, err)
				continue
			}
			t.Logf("host event %s", line)
		}
	})
}

// count returns how often the workbench received the record.
func (w *elementWorkbench) count(record string) int {
	return len(slices.DeleteFunc(w.Received(), func(received string) bool { return received != record }))
}

// The reload request of a ready workbench starts it again with a new start of the host, and the new workbench reports that it is ready.
// The views of the previous workbench end with it, and their surfaces wait for the layout of the new one.
func TestE2EAReloadRequestStartsTheWorkbenchAgain(t *testing.T) {
	session := viewHost(t)
	t.Cleanup(func() { session.layout(t) })
	// Registered after the cleanup layout, so it runs before it and writes the state that the failure left.
	session.logOnFailure(t)
	name := session.window.Name()
	support.Wait(t, "the first start of the workbench", func() bool { return session.workbench.count("shown "+name) > 0 })
	builds, starts := session.workbench.count("build "+name), session.workbench.count("shown "+name)
	session.layout(t, viewSurface("reloaded", true))
	process := session.row(t, "reloaded").Process
	session.window.Emit("page-reload")
	support.Wait(t, "the second start of the workbench", func() bool { return session.workbench.count("shown "+name) == starts+1 })
	if got := session.workbench.count("build " + name); got != builds+1 {
		t.Fatalf("%d builds after the reload, want %d", got, builds+1)
	}
	if got := session.workbench.count("close " + name); got == 0 {
		t.Fatal("the previous workbench did not close")
	}
	support.Wait(t, "the end of the view of the previous workbench", func() bool {
		return process == 0 || errors.Is(syscall.Kill(int(process), 0), syscall.ESRCH)
	})
}

// call runs a host call of the workbench with its request.
func (s *viewSession) call(t *testing.T, call func(context.Context, json.RawMessage) error, request any) {
	t.Helper()
	wire, err := json.Marshal(request)
	if err != nil {
		t.Fatal(err)
	}
	if err := call(*s.workbench.context.Load(), wire); err != nil {
		t.Fatal(err)
	}
}

// A document region of a view page shows at its insets in the surface host of the view, and leaves with the surface.
func TestE2EADocumentRegionShowsInTheSurfaceHostOfItsView(t *testing.T) {
	session := viewHost(t)
	t.Cleanup(func() { session.layout(t) })
	surface := viewSurface("paged", true)
	surface.Composition.Regions = []host.SurfaceRegion{{Name: "page", Kind: "document", Input: "native"}}
	session.layout(t, surface)
	document := host.DocumentRequest{Surface: "paged", Document: "page"}
	session.call(t, session.host.DocumentAttach, document)
	session.call(t, session.host.CompositionPlace, host.CompositionPlaceRequest{Surface: "paged", Revision: 1, Overlays: []host.CompositionPlacement{},
		Regions: []host.CompositionPlacement{{Name: "page", Left: 10, Top: 20, Right: 30, Bottom: 40, Visible: true}}})
	document.URL = "soksak://probe/ui/page.html"
	session.call(t, session.host.DocumentLoad, document)
	support.Wait(t, "the document region in the native view", func() bool {
		return slices.ContainsFunc(session.rows(t), func(row viewRow) bool {
			return row.Document && !row.Hidden && row.X == box.X+10 && row.Y == box.Y+20 && row.Width == box.W-40 && row.Height == box.H-60
		})
	})
	session.layout(t)
	support.Wait(t, "the end of the document region", func() bool {
		return !slices.ContainsFunc(session.rows(t), func(row viewRow) bool { return row.Document })
	})
}

// A region in the lease mode presents the frame of its supplier: the window server marks the frame in use while the surface host of
// the view shows it, the region gives each frame back when the next one replaces it, and the mark clears after that.
func TestE2EALeasedImageRegionHoldsItsFrameWhilePresented(t *testing.T) {
	session := viewHost(t)
	t.Cleanup(func() { session.layout(t) })
	session.layout(t, viewSurface("leased", true))
	element, ok := host.ElementOf(session.host, session.window, "leased")
	if !ok {
		t.Fatal("the surface has no element")
	}
	var mu sync.Mutex
	var released []int
	var image unsafe.Pointer
	var err error
	mygo.RunOnMain(func() {
		image, err = session.system.CreateImage(element.Surface, "leased", func(string) {}, func(_, _ uint64, sequence int) {
			mu.Lock()
			defer mu.Unlock()
			released = append(released, sequence)
		})
		if err == nil {
			session.system.PlaceImage(image, 10, 20, 30, 40, true)
		}
	})
	if err != nil {
		t.Fatal(err)
	}
	gone := false
	close := func() {
		if !gone {
			gone = true
			mygo.RunOnMain(func() { session.system.CloseImage(image) })
		}
	}
	t.Cleanup(close)
	var width, height int
	var scale float64
	support.Wait(t, "the raster of the image region", func() bool {
		var placed bool
		mygo.RunOnMain(func() { width, height, scale, placed = session.system.RasterImage(image) })
		return placed && width > 0 && height > 0
	})
	nonce := [16]byte{1, 2, 3}
	frames := make([]*darwin.Frame, 3)
	for index := range frames {
		if frames[index], err = darwin.NewFrame(width, height, nonce); err != nil {
			t.Fatal(err)
		}
		defer frames[index].Close()
	}
	present := func(index int) {
		t.Helper()
		var err error
		mygo.RunOnMain(func() {
			err = session.system.PresentImage(image, frames[index].ID(), nonce, float64(width), float64(height), scale, 1, 1, index+1)
		})
		if err != nil {
			t.Fatal(err)
		}
	}
	present(0)
	support.Wait(t, "the mark of the presented frame", frames[0].InUse)
	present(1)
	support.Wait(t, "the mark of the replacing frame", frames[1].InUse)
	mu.Lock()
	if !slices.Equal(released, []int{1}) {
		t.Fatalf("the region released %v after the second frame", released)
	}
	mu.Unlock()
	present(2)
	support.Wait(t, "the mark of the replaced frame to clear", func() bool { return !frames[0].InUse() })
	close()
	mu.Lock()
	defer mu.Unlock()
	if !slices.Equal(released, []int{1, 2, 3}) {
		t.Fatalf("the region released %v after it closed", released)
	}
}
