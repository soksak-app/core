package host

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"sync"
	"testing"
	"time"
	"unsafe"

	"github.com/soksak-app/core/packages/host/go/src/platform"
	support "github.com/soksak-app/core/packages/host/go/tests/platform/darwin"
)

// viewProbe is the surfaces of one real view of plugin probe on a real surface of a real window, and the events that the host sent to
// its window. The view loads testdata/view-plugin/ui/page.html, which reports its first script and each message that the host posts to
// it as a view call, so a test reads what the page received from the events that the host forwards.
type viewProbe struct {
	s       *Surfaces
	window  platform.Window
	surface unsafe.Pointer
	mu      sync.Mutex
	events  []hostEvent
	changed chan struct{}
}

// record keeps the event and wakes the waits. The native layer calls it on the main thread.
func (p *viewProbe) record(name string, data any) {
	p.mu.Lock()
	p.events = append(p.events, hostEvent{name, data})
	p.mu.Unlock()
	select {
	case p.changed <- struct{}{}:
	default:
	}
}

// eventsNow returns the events that arrived so far.
func (p *viewProbe) eventsNow() []hostEvent {
	p.mu.Lock()
	defer p.mu.Unlock()
	return append([]hostEvent(nil), p.events...)
}

// wait returns the first event that match accepts, after it arrived: the wait ends by the event and has no clock of its own, and the
// limit of the test ends a wait whose event does not come.
func (p *viewProbe) wait(t *testing.T, what string, match func(hostEvent) bool) hostEvent {
	t.Helper()
	limit := time.After(10 * time.Second)
	for {
		for _, event := range p.eventsNow() {
			if match(event) {
				return event
			}
		}
		select {
		case <-p.changed:
		case <-limit:
			t.Fatalf("no event arrived for: %s; the events so far are %v", what, p.eventsNow())
		}
	}
}

// waitCall returns the params of the first view call of command that the page made.
func (p *viewProbe) waitCall(t *testing.T, command string) map[string]any {
	t.Helper()
	event := p.wait(t, "the view call "+command, func(event hostEvent) bool {
		data, _ := event.data.(map[string]any)
		return event.name == "view-call" && data["command"] == command
	})
	var params map[string]any
	if raw, ok := event.data.(map[string]any)["params"].(json.RawMessage); ok {
		if err := json.Unmarshal(raw, &params); err != nil {
			t.Fatalf("the params of %s are not an object: %v: %s", command, err, raw)
		}
	}
	return params
}

// viewStore is the folder of the persistent data store of the views of the tests, which every view of the run shares. WebKit writes to a data
// store from its network process after the documents of the store closed, and no operation of the platform ends a store, so a test
// cannot remove the folder of its own view when it ends. The folder is created by the first view and removed when the run ended, by
// removeViewStore.
var viewStore struct {
	sync.Once
	directory string
	err       error
}

func viewStoreDirectory(t *testing.T) string {
	t.Helper()
	viewStore.Do(func() { viewStore.directory, viewStore.err = os.MkdirTemp("", "soksak-view-store-") })
	if viewStore.err != nil {
		t.Fatalf("create the data store folder of the views: %v", viewStore.err)
	}
	return viewStore.directory
}

// removeViewStore removes the folder of the data store of the views when the run of the tests ended and reports a failure on the standard
// error. It returns whether the folder is gone.
func removeViewStore() bool {
	if viewStore.directory == "" {
		return true
	}
	if err := os.RemoveAll(viewStore.directory); err != nil {
		fmt.Fprintf(os.Stderr, "the data store folder of the views was not removed: %v\n", err)
		return false
	}
	return true
}

// realViewProbe attaches the view that the test describes to a real surface of a real window and returns it. The channel script is the
// fixture testdata/view-channel.js, the folder of the plugin is testdata/view-plugin, and the surfaces, the document and the window close
// with the test.
func realViewProbe(t *testing.T, theme Theme, start ViewStart) *viewProbe {
	t.Helper()
	return realViewProbeOn(t, theme, start, "ui/page.html")
}

// echoViewProbe attaches a view whose page sends nothing of its own and reports each message that the host posts to it, so the test
// gives the host the messages of the page itself (message) and reads what the host posts (received).
func echoViewProbe(t *testing.T) *viewProbe {
	t.Helper()
	p := realViewProbeOn(t, Theme{Scheme: "dark", Tokens: map[string]string{"bg": "#000000"}}, nullOriginStart(), "ui/echo.html")
	p.waitCall(t, "probe.opened")
	return p
}

// realViewProbeOn attaches the view of the page of the plugin folder, as realViewProbe does for ui/page.html.
func realViewProbeOn(t *testing.T, theme Theme, start ViewStart, page string) *viewProbe {
	t.Helper()
	probe := newViewProbe(t, theme)
	if err := probe.attach(t, start, page); err != nil {
		t.Fatalf("attach the view: %v", err)
	}
	return probe
}

// testdataText returns the text of a file of the testdata folder of the package.
func testdataText(t *testing.T, name string) string {
	t.Helper()
	text, err := os.ReadFile(filepath.Join("testdata", name))
	if err != nil {
		t.Fatal(err)
	}
	return string(text)
}

// newViewProbe creates the window, its main page, the surface of the view and the surfaces of the host that name it, without a view. The
// platform of the operating system is the platform of the host for the test, the framework runs its steps on the main thread, the view
// import map is the fixture testdata/view-imports.json, and the surface and the window close with the test.
func newViewProbe(t *testing.T, theme Theme) *viewProbe {
	t.Helper()
	useCurrentPlatformForViews(t)
	savedFramework := framework
	framework = mainThreadFramework{}
	t.Cleanup(func() { framework = savedFramework })
	probe := &viewProbe{changed: make(chan struct{}, 1)}
	probe.window = support.TitledWindowWithMainPage(t, runOnMainThread, 500, 400, "main-page.html")
	var err error
	runOnMainThread(func() { err = system.SetViewImportMap(testdataText(t, "view-imports.json")) })
	if err != nil {
		t.Fatalf("set the view import map: %v", err)
	}
	probe.s = &Surfaces{documents: NewDocuments(), streams: NewDocumentStreams(), images: NewImages(), lifecycle: newViewLifecycle(),
		host: &Host{configDir: t.TempDir()}, invoke: func(task func()) { task() }, events: probe.record, theme: theme,
		views: map[string]*nativeWebview{}, named: map[uintptr]string{}}
	// The surface is created as the preparation of a layout creates it: a logical surface of the window that the host names.
	view, err := probe.s.createRegisteredSurface(runOnMainThread, "probe-surface", func() (unsafe.Pointer, error) { return system.CreateSurface(probe.window) })
	if err != nil {
		t.Fatalf("create the surface of the view: %v", err)
	}
	probe.s.views["probe-surface"] = view
	probe.surface = view.handle
	runOnMainThread(func() {
		system.SetSurfaceBounds(probe.surface, 0, 0, 500, 400)
		system.SetSurfaceHiddenHandle(probe.surface, false)
	})
	t.Cleanup(func() {
		runOnMainThread(func() {
			probe.s.closeSurfaceDocuments("probe-surface")
			system.CloseSurface(probe.surface)
		})
	})
	return probe
}

// attach attaches the view of page of the plugin folder testdata/view-plugin to the surface with the channel script of
// testdata/view-channel.js, places it over its whole surface when it attached, and returns the failure of the attachment.
func (p *viewProbe) attach(t *testing.T, start ViewStart, page string) error {
	t.Helper()
	folder, err := filepath.Abs(filepath.Join("testdata", "view-plugin"))
	if err != nil {
		t.Fatal(err)
	}
	runOnMainThread(func() {
		err = p.s.attachView("probe-surface", p.surface, viewStoreDirectory(t), folder, "probe", page, testdataText(t, "view-channel.js"), start)
	})
	if err != nil {
		return err
	}
	// The view is placed over its whole surface, as the synchronization of the view does after it attached the view.
	document, err := p.s.documents.Get(DocumentKey{Surface: "probe-surface", Name: viewRegionName})
	if err != nil {
		t.Fatal(err)
	}
	runOnMainThread(func() { system.PlaceDocument(document, 0, 0, 0, 0, true) })
	return nil
}

// webviews returns the number of the web views that the window holds, which the platform reads from the window.
func (p *viewProbe) webviews(t *testing.T) int {
	t.Helper()
	var facts string
	var err error
	runOnMainThread(func() { facts, err = system.WindowFacts(p.window) })
	if err != nil {
		t.Fatalf("the facts of the window: %v", err)
	}
	var read struct{ Webviews []json.RawMessage }
	if err := json.Unmarshal([]byte(facts), &read); err != nil {
		t.Fatalf("the facts of the window are not JSON: %v", err)
	}
	return len(read.Webviews)
}

// main runs task on the main thread, where the host handles the messages of its views.
func (p *viewProbe) main(task func()) { runOnMainThread(task) }

// message gives the host the message of the page of the view, as the native handler does, and returns the failure that the host writes to
// its log for it. The message is the envelope of the handler: {"message": <message>}.
func (p *viewProbe) message(text string) error {
	var failure error
	runOnMainThread(func() { failure = p.s.viewMessage("probe-surface", text) })
	return failure
}

// received returns the messages that the host posted to the document of the view and that the page reported, in order.
func (p *viewProbe) received() []map[string]any {
	var messages []map[string]any
	for _, event := range p.eventsNow() {
		data, _ := event.data.(map[string]any)
		if event.name != "view-call" || data["command"] != "probe.received" {
			continue
		}
		var message map[string]any
		if raw, ok := data["params"].(json.RawMessage); ok {
			if err := json.Unmarshal(raw, &message); err != nil {
				message = map[string]any{"unreadable": string(raw)}
			}
		}
		messages = append(messages, message)
	}
	return messages
}

// waitReceived waits until the page reported count messages of the host and returns them.
func (p *viewProbe) waitReceived(t *testing.T, count int) []map[string]any {
	t.Helper()
	p.wait(t, fmt.Sprintf("%d messages of the host reported by the page", count), func(hostEvent) bool { return len(p.received()) >= count })
	return p.received()
}

// ready gives the host the ready message of the page and waits for the theme that the host posts to the ready document.
func (p *viewProbe) ready(t *testing.T) {
	t.Helper()
	before := len(p.received())
	if err := p.message(`{"message":{"event":"view.ready","plugin":"probe","document":"doc-1","time_origin":1234.5}}`); err != nil {
		t.Fatalf("ready message: %v", err)
	}
	if theme := p.waitReceived(t, before+1)[before]; theme["event"] != "theme" {
		t.Fatalf("the first message to the ready document is %v, want the theme", theme)
	}
}

// openCalls returns the view calls that the host holds open for the view, without the echoes of the page.
func (p *viewProbe) openCalls() []openViewCall {
	var calls []openViewCall
	for _, call := range p.s.documents.endViewCalls("probe-surface") {
		if call.command != "probe.received" && call.command != "probe.opened" {
			calls = append(calls, call)
		}
	}
	return calls
}
