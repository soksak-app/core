package host

import (
	"encoding/json"
	"errors"
	"reflect"
	"strings"
	"testing"
	"time"
	"unsafe"

	"github.com/soksak-app/core/packages/host/wailsv3/src/platform"
)

// contract: exposure.host-window.reads-during-surface-close
func TestSurfaceNameIsForgottenInTheStepThatClosesItsNativeView(t *testing.T) {
	s := &Surfaces{named: map[uintptr]string{}}
	// A view without a native handle closes without calling the native code.
	view := &nativeWebview{owner: s}
	s.named[uintptr(view.handle)] = "tab-2"
	namesAfterStep := -1
	// The step runs at once, as the UI thread would run it. The names are read after the step returns, which is when a
	// window status reading on the UI thread that follows the close would see them.
	run := func(step func()) {
		step()
		namesAfterStep = len(s.named)
	}
	s.closeRegisteredSurface(run, view)
	if namesAfterStep != 0 {
		t.Fatalf("names after the close step: got %d, want 0 (tab-2 is still named after its native view closed)", namesAfterStep)
	}
}

// contract: exposure.host-window.reads-during-surface-creation
func TestSurfaceIsNamedWhenItsNativeViewIsCreated(t *testing.T) {
	s := &Surfaces{named: map[uintptr]string{}}
	native := new(int)
	// The creation runs its step at once, as the UI thread would run it.
	view, err := s.createRegisteredSurface(func(step func()) { step() }, "tab-4leevm", func() (unsafe.Pointer, error) {
		return unsafe.Pointer(native), nil
	})
	if err != nil {
		t.Fatalf("create: %v", err)
	}
	if got := s.viewNames()[uint64(uintptr(view.handle))]; got != "tab-4leevm" {
		t.Fatalf("native view of tab-4leevm is named %q after creation", got)
	}
	// A failed creation names nothing.
	_, err = s.createRegisteredSurface(func(step func()) { step() }, "tab-6", func() (unsafe.Pointer, error) {
		return nil, errors.New("no window")
	})
	if err == nil || len(s.named) != 1 {
		t.Fatalf("failed creation: err %v, names %d", err, len(s.named))
	}
}

// contract: exposure.host-window.unregistered-surface-named
func TestUnregisteredNativeSurfaceViewFailsWithItsAddress(t *testing.T) {
	named := map[uint64]string{7: "tab-2"}
	id, err := registeredSurface(named, 7)
	if err != nil || id != "tab-2" {
		t.Fatalf("registered view: id %q, err %v; want tab-2 and no error", id, err)
	}
	_, err = registeredSurface(named, 9)
	if err == nil || err.Error() != "unregistered native surface 9" {
		t.Fatalf("unregistered view: err %v; want unregistered native surface 9", err)
	}
}

// viewPlatform is the platform of the view tests. It records the document web views that are created with their configuration and
// the addresses that they load. Every other operation of the platform interface is not implemented by it.
type viewPlatform struct {
	platform.Platform
	created []viewCreation
	loaded  []string
}

type viewCreation struct {
	folder, plugin, channel string
}

func (p *viewPlatform) CreateDocument(surface unsafe.Pointer, directory, folder, plugin, channel string, changed func(state string)) (unsafe.Pointer, error) {
	p.created = append(p.created, viewCreation{folder: folder, plugin: plugin, channel: channel})
	return unsafe.Pointer(new(int)), nil
}

func (p *viewPlatform) LoadDocument(document unsafe.Pointer, url string) bool {
	p.loaded = append(p.loaded, url)
	return true
}

func (p *viewPlatform) PlaceDocument(document unsafe.Pointer, left, top, right, bottom float64, visible bool) {
}

func (p *viewPlatform) CloseDocument(document unsafe.Pointer) {}

func (p *viewPlatform) SetViewMessage(document unsafe.Pointer, message func(value string)) error {
	return nil
}

func (p *viewPlatform) SetViewEnded(document unsafe.Pointer, ended func()) error {
	return nil
}

func (p *viewPlatform) SetViewResponsiveness(document unsafe.Pointer, responsiveness func(responsive bool)) error {
	return nil
}

func (p *viewPlatform) AddDocumentScript(document unsafe.Pointer, source string) error { return nil }

// contract: view.create-loads-page
func TestViewSurfaceCreatesViewConfigurationAndLoadsItsPage(t *testing.T) {
	fake := &viewPlatform{}
	saved := system
	system = fake
	t.Cleanup(func() { system = saved })
	s := &Surfaces{documents: NewDocuments()}
	if err := s.attachView("probe-surface", unsafe.Pointer(new(int)), "/config/document-data", "/plugins/probe", "probe", "ui/page.html", "channel-script", nullOriginStart()); err != nil {
		t.Fatalf("attach view: %v", err)
	}
	if len(fake.created) != 1 || fake.created[0].channel != "channel-script" || fake.created[0].plugin != "probe" || fake.created[0].folder != "/plugins/probe" {
		t.Fatalf("created documents: %+v, want one view configuration of plugin probe in its folder with the channel script", fake.created)
	}
	if want := []string{"sok://probe/ui/page.html"}; !reflect.DeepEqual(fake.loaded, want) {
		t.Fatalf("loaded addresses: %v, want %v", fake.loaded, want)
	}
	if _, err := s.documents.Get(DocumentKey{Surface: "probe-surface", Name: viewRegionName}); err != nil {
		t.Fatalf("the view is not recorded for its surface: %v", err)
	}
}

// contract: view.composition.page-and-regions
func TestViewCompositionDeclaresPageWithOptionalRegions(t *testing.T) {
	if err := validateComposition("probe", SurfaceComposition{Kind: "view", Page: "ui/page.html"}); err != nil {
		t.Fatalf("view without regions: %v", err)
	}
	document := SurfaceRegion{Name: "page", Kind: "document", Input: "native"}
	if err := validateComposition("probe", SurfaceComposition{Kind: "view", Page: "ui/page.html", Regions: []SurfaceRegion{document}, Overlays: []string{}}); err != nil {
		t.Fatalf("view with a region: %v", err)
	}
	for _, composition := range []SurfaceComposition{
		{Kind: "view"},
		{Kind: "view", Page: "../page.html"},
		{Kind: "view", Page: "ui/page.js"},
		{Kind: "view", Page: "ui/.binary/page.html"},
		{Kind: "hybrid", Page: "ui/page.html", Regions: []SurfaceRegion{document}, Overlays: []string{}},
	} {
		if err := validateComposition("probe", composition); err == nil {
			t.Fatalf("composition %+v is accepted", composition)
		}
	}
}

// channelPlatform is the platform of the view channel tests. It keeps the receiver of the sok-view messages of each document and
// records each message that the host posts to a document.
type channelPlatform struct {
	viewPlatform
	receive func(string)
	posted  []string
}

func (p *channelPlatform) SetViewMessage(document unsafe.Pointer, message func(value string)) error {
	p.receive = message
	return nil
}

func (p *channelPlatform) PostDocument(document unsafe.Pointer, value string) bool {
	p.posted = append(p.posted, value)
	return true
}

// newViewChannelSurfaces returns the surfaces of one attached view of plugin probe and the platform that records its messages.
func newViewChannelSurfaces(t *testing.T) (*Surfaces, *channelPlatform) {
	t.Helper()
	fake := &channelPlatform{}
	var _ platform.Platform = fake
	saved := system
	system = fake
	t.Cleanup(func() { system = saved })
	s := &Surfaces{documents: NewDocuments()}
	if err := s.attachView("probe-surface", unsafe.Pointer(new(int)), "/config/document-data", "/plugins/probe", "probe", "ui/page.html", "channel-script", nullOriginStart()); err != nil {
		t.Fatalf("attach view: %v", err)
	}
	return s, fake
}

// contract: view.channel.ready
func TestViewChannelRecordsReadyDocumentPostsThemeAndClearsOnNavigation(t *testing.T) {
	s, fake := newViewChannelSurfaces(t)
	s.theme = Theme{Scheme: "dark", Tokens: map[string]string{"bg": "#000000"}}
	ready := `{"message":{"event":"view.ready","plugin":"probe","document":"doc-1"}}`
	if err := s.viewMessage("probe-surface", ready); err != nil {
		t.Fatalf("ready message: %v", err)
	}
	if len(fake.posted) != 1 {
		t.Fatalf("messages posted after ready: %d, want the current theme", len(fake.posted))
	}
	var theme map[string]any
	if err := json.Unmarshal([]byte(fake.posted[0]), &theme); err != nil {
		t.Fatalf("theme message is not JSON: %v", err)
	}
	if theme["sok"] != float64(1) || theme["event"] != "theme" {
		t.Fatalf("theme message %v, want sok 1 and event theme", theme)
	}
	if _, has := theme["theme"]; has || theme["data"] == nil {
		t.Fatalf("theme message %v, want the theme in its data field", theme)
	}
	if err := s.postView("probe-surface", map[string]any{"event": "probe"}); err != nil {
		t.Fatalf("post to a ready view: %v", err)
	}
	s.viewState("probe-surface", `{"loading":true}`)
	if err := s.postView("probe-surface", map[string]any{"event": "probe"}); err == nil {
		t.Fatalf("post after navigation is accepted, want the ready record cleared")
	}
}

// nativeViewState is the document-state payload of a view as the native host sends it (docs/spec/native-surfaces.md, document-state):
// loading is a JSON boolean.
const nativeViewState = `{"url":"sok://probe/ui/page.html","title":"probe","loading":false,"progress":1,"canGoBack":false,"canGoForward":false,"error":null,"scroll":{"x":0,"y":0},"history":{"entries":[],"index":-1},"link":""}`

// contract: view.channel.state-boolean
func TestViewStateAcceptsTheNativePayloadWithABooleanLoading(t *testing.T) {
	s, _ := newViewChannelSurfaces(t)
	if err := s.viewState("probe-surface", nativeViewState); err != nil {
		t.Fatalf("native view state: %v", err)
	}
}

// contract: view.channel.state-numeric-refused
func TestViewStateRefusesANumericLoadingWithTheSurfaceAndTheTypeError(t *testing.T) {
	s, _ := newViewChannelSurfaces(t)
	payload := strings.Replace(nativeViewState, `"loading":false`, `"loading":1`, 1)
	err := s.viewState("probe-surface", payload)
	if err == nil || !strings.HasPrefix(err.Error(), "probe-surface: view state is not JSON: json: cannot unmarshal number into Go struct field") {
		t.Fatalf("numeric loading: %v, want the surface and the type error", err)
	}
}

// contract: view.channel.post-before-ready
func TestViewChannelRefusesPostBeforeReadyWithItsText(t *testing.T) {
	s, fake := newViewChannelSurfaces(t)
	err := s.postView("probe-surface", map[string]any{"event": "probe"})
	if err == nil || err.Error() != "probe-surface has no ready document" {
		t.Fatalf("post before ready: %v, want probe-surface has no ready document", err)
	}
	if len(fake.posted) != 0 {
		t.Fatalf("posted before ready: %v", fake.posted)
	}
}

// contract: view.channel.queue-full
func TestViewChannelReportsQueueFullAndForeignFrameWithTheirReasons(t *testing.T) {
	s, _ := newViewChannelSurfaces(t)
	full := `{"message":{"event":"view.error","plugin":"probe","reason":"queue full for probe"}}`
	if err := s.viewMessage("probe-surface", full); err == nil || err.Error() != "queue full for probe" {
		t.Fatalf("queue full: %v, want queue full for probe", err)
	}
	foreign := `{"error":"the view channel message comes from a frame that is not the main frame"}`
	if err := s.viewMessage("probe-surface", foreign); err == nil || err.Error() != "the view channel message comes from a frame that is not the main frame" {
		t.Fatalf("foreign frame: %v", err)
	}
}

// contract: view.restart.limit
func TestViewProcessEndsRestartTheViewUntilTheFourthFailureWithinFiveMinutes(t *testing.T) {
	clock := &fakeClock{}
	s, fake, native := newLifecycleSurfaces(t, clock)
	for _, offset := range []time.Duration{0, 60 * time.Second, 120 * time.Second, 180 * time.Second} {
		clock.set(offset)
		endView(t, s, fake)
	}
	if len(fake.created) != 4 || len(fake.closed) != 4 {
		t.Fatalf("created %d views and closed %d, want the first view and three restarts, each failure closing its view", len(fake.created), len(fake.closed))
	}
	if _, err := s.documents.Get(DocumentKey{Surface: "probe-surface", Name: viewRegionName}); err == nil {
		t.Fatalf("a view is recorded after the restart limit")
	}
	// The tab is reopened: its surface is removed and created again, which clears the record.
	s.viewRecords().forget("probe-surface")
	// The reopened surface resolves its folder again; the test replaces the installed-plugin lookup with the same folder.
	reopened := s.viewRecords().track("probe-surface", native, "probe", "ui/page.html", true)
	reopened.directory, reopened.folder = "/config/document-data", "/plugins/probe"
	clock.set(240 * time.Second)
	if err := s.syncView("probe-surface", native, "probe", "ui/page.html", true, nullOriginStart()); err != nil {
		t.Fatalf("sync after the tab is reopened: %v", err)
	}
	if len(fake.created) != 5 {
		t.Fatalf("views created after the reopen: %d, want the view created again", len(fake.created))
	}
}

// contract: view.channel.overflow-closes
func TestViewChannelOverflowClosesTheViewAndCreatesItAgain(t *testing.T) {
	clock := &fakeClock{}
	s, fake, _ := newLifecycleSurfaces(t, clock)
	first := fake.created[0]
	full := `{"message":{"event":"view.error","plugin":"probe","reason":"queue full for probe"}}`
	s.viewReceived("probe-surface", first, full)
	if len(fake.closed) != 1 || fake.closed[0] != first {
		t.Fatalf("closed views after the overflow: %d, want the overflowed view", len(fake.closed))
	}
	if len(fake.created) != 2 {
		t.Fatalf("created views after the overflow: %d, want the view created again", len(fake.created))
	}
	// A message that arrives from the view closed by the overflow is a late message and closes nothing.
	s.viewReceived("probe-surface", first, full)
	if len(fake.closed) != 1 || len(fake.created) != 2 {
		t.Fatalf("a message of the closed view changed the views: closed %d, created %d", len(fake.closed), len(fake.created))
	}
}

// contract: view.call.forward
func TestViewCallIsForwardedWithItsPluginAndSurface(t *testing.T) {
	payload, ok, err := ViewCallEvent("probe-surface", "probe", json.RawMessage(`{"id":7,"command":"tab.state.read","params":{"a":1}}`))
	if err != nil {
		t.Fatalf("call request: %v", err)
	}
	if !ok {
		t.Fatalf("a call request is not forwarded")
	}
	if payload["surface"] != "probe-surface" || payload["plugin"] != "probe" || payload["id"] != uint64(7) || payload["command"] != "tab.state.read" {
		t.Fatalf("forwarded payload %v, want surface probe-surface, plugin probe, id 7, command tab.state.read", payload)
	}
	if _, ok, _ := ViewCallEvent("probe-surface", "probe", json.RawMessage(`{"event":"view.ready"}`)); ok {
		t.Fatalf("a ready message is forwarded as a call")
	}
}

// contract: view.declared-ui.snapshot
func TestViewDeclaredSnapshotIsForwardedWithItsSurfaceAndPlugin(t *testing.T) {
	payload, ok, err := DeclaredSnapshotEvent("probe-surface", "probe", json.RawMessage(`{"event":"declared-ui.snapshot","plugin":"probe","status":"probe.lines","seq":3,"value":{"elements":[]},"skipped":1}`))
	if err != nil {
		t.Fatalf("snapshot: %v", err)
	}
	if !ok {
		t.Fatalf("a declared UI snapshot is not forwarded")
	}
	if payload["surface"] != "probe-surface" || payload["plugin"] != "probe" || payload["status"] != "probe.lines" || payload["seq"] != uint64(3) || payload["skipped"] != uint64(1) {
		t.Fatalf("forwarded payload %v, want surface probe-surface, plugin probe, status probe.lines, seq 3, skipped 1", payload)
	}
	value, ok := payload["value"].(json.RawMessage)
	if !ok || string(value) != `{"elements":[]}` {
		t.Fatalf("forwarded value %v, want the value of the snapshot", payload["value"])
	}
	// A value of null stays present: the receiver validates it like any other value (docs/spec/declared-ui.md).
	payload, ok, err = DeclaredSnapshotEvent("probe-surface", "probe", json.RawMessage(`{"event":"declared-ui.snapshot","plugin":"probe","status":"probe.lines","seq":1,"value":null,"skipped":0}`))
	if err != nil || !ok {
		t.Fatalf("snapshot with a null value: ok %v, err %v", ok, err)
	}
	if value, ok := payload["value"].(json.RawMessage); !ok || string(value) != "null" {
		t.Fatalf("forwarded value %v, want null", payload["value"])
	}
	if _, ok, _ := DeclaredSnapshotEvent("probe-surface", "probe", json.RawMessage(`{"event":"view.ready","plugin":"probe","document":"doc-1"}`)); ok {
		t.Fatalf("a ready message is forwarded as a snapshot")
	}
}

// contract: view.declared-ui.snapshot
func TestViewDeclaredSnapshotInvalidFieldsAreErrorsNotForwarded(t *testing.T) {
	for _, test := range []struct{ message, want string }{
		{`{"event":"declared-ui.snapshot","status":"probe.lines","seq":1,"value":null,"skipped":0}`, `probe-surface: declared UI snapshot names no plugin`},
		{`{"event":"declared-ui.snapshot","plugin":"other","status":"probe.lines","seq":1,"value":null,"skipped":0}`, `probe-surface: declared UI snapshot names plugin "other", want plugin "probe"`},
		{`{"event":"declared-ui.snapshot","plugin":"probe","seq":1,"value":null,"skipped":0}`, `probe-surface: declared UI snapshot has no status`},
		{`{"event":"declared-ui.snapshot","plugin":"probe","status":"","seq":1,"value":null,"skipped":0}`, `probe-surface: declared UI snapshot has no status`},
		{`{"event":"declared-ui.snapshot","plugin":"probe","status":"probe.lines","value":null,"skipped":0}`, `probe-surface: declared UI snapshot of status "probe.lines" has no seq from 1`},
		{`{"event":"declared-ui.snapshot","plugin":"probe","status":"probe.lines","seq":0,"value":null,"skipped":0}`, `probe-surface: declared UI snapshot of status "probe.lines" has no seq from 1`},
		{`{"event":"declared-ui.snapshot","plugin":"probe","status":"probe.lines","seq":1,"value":null}`, `probe-surface: declared UI snapshot of status "probe.lines" has no skipped count`},
		{`{"event":"declared-ui.snapshot","plugin":"probe","status":"probe.lines","seq":1,"skipped":0}`, `probe-surface: declared UI snapshot of status "probe.lines" has no value`},
	} {
		payload, _, err := DeclaredSnapshotEvent("probe-surface", "probe", json.RawMessage(test.message))
		if err == nil || err.Error() != test.want {
			t.Fatalf("message %s: %v, want %s", test.message, err, test.want)
		}
		if payload != nil {
			t.Fatalf("message %s returns payload %v with its error", test.message, payload)
		}
	}
	// A snapshot that names another plugin is an error, not a forwarding.
	payload, ok, err := DeclaredSnapshotEvent("probe-surface", "other", json.RawMessage(`{"event":"declared-ui.snapshot","plugin":"probe","status":"probe.lines","seq":1,"value":null,"skipped":0}`))
	if err == nil || err.Error() != `probe-surface: declared UI snapshot names plugin "probe", want plugin "other"` || payload != nil || !ok {
		t.Fatalf("foreign plugin: ok %v, payload %v, err %v", ok, payload, err)
	}
}

// contract: view.call.reply
func TestViewCallReplyReturnsThroughTheChannelPost(t *testing.T) {
	s, fake := newViewChannelSurfaces(t)
	ready := `{"message":{"event":"view.ready","plugin":"probe","document":"doc-1"}}`
	if err := s.viewMessage("probe-surface", ready); err != nil {
		t.Fatalf("ready message: %v", err)
	}
	before := len(fake.posted)
	if err := s.replyView(ViewReplyRequest{Surface: "probe-surface", ID: 7, Result: json.RawMessage(`{"count":2}`)}); err != nil {
		t.Fatalf("reply: %v", err)
	}
	if len(fake.posted) != before+1 {
		t.Fatalf("replies posted: %d, want 1", len(fake.posted)-before)
	}
	var reply map[string]any
	if err := json.Unmarshal([]byte(fake.posted[len(fake.posted)-1]), &reply); err != nil {
		t.Fatalf("reply is not JSON: %v", err)
	}
	if reply["sok"] != float64(1) || reply["id"] != float64(7) || !reflect.DeepEqual(reply["result"], map[string]any{"count": float64(2)}) {
		t.Fatalf("reply %v, want sok 1, id 7 and the result", reply)
	}
	if err := s.replyView(ViewReplyRequest{Surface: "probe-surface", ID: 8, Error: &ViewReplyError{Code: -32000, Message: "tab.state is not declared"}}); err != nil {
		t.Fatalf("error reply: %v", err)
	}
	var failed map[string]any
	if err := json.Unmarshal([]byte(fake.posted[len(fake.posted)-1]), &failed); err != nil {
		t.Fatalf("error reply is not JSON: %v", err)
	}
	if failed["id"] != float64(8) || failed["error"] == nil {
		t.Fatalf("error reply %v, want id 8 and the error", failed)
	}
	if err := s.replyView(ViewReplyRequest{Surface: "probe-surface", ID: 9}); err == nil || err.Error() != "view reply 9 has neither a result nor an error" {
		t.Fatalf("reply without result or error: %v", err)
	}
}

// contract: view.call.cancel
func TestViewCallCancelIsForwardedWithItsPluginAndSurface(t *testing.T) {
	payload, ok, err := ViewCallEvent("probe-surface", "probe", json.RawMessage(`{"id":7,"cancel":true}`))
	if err != nil {
		t.Fatalf("cancel message: %v", err)
	}
	if !ok {
		t.Fatalf("a cancel message is not forwarded")
	}
	if payload["surface"] != "probe-surface" || payload["plugin"] != "probe" || payload["id"] != uint64(7) || payload["cancel"] != true {
		t.Fatalf("forwarded payload %v, want surface probe-surface, plugin probe, id 7, cancel true", payload)
	}
	if _, has := payload["command"]; has {
		t.Fatalf("forwarded cancel %v carries a command", payload)
	}
}

// contract: view.call.forward
func TestViewCallCarriesTheCidsOfItsCause(t *testing.T) {
	payload, ok, err := ViewCallEvent("probe-surface", "probe", json.RawMessage(`{"id":8,"command":"demo.run","params":{"x":1},"cids":["p1700000000000.3"]}`))
	if err != nil || !ok {
		t.Fatalf("call request with cids: ok %v, err %v", ok, err)
	}
	if !reflect.DeepEqual(payload["cids"], []string{"p1700000000000.3"}) {
		t.Fatalf("forwarded call %v, want the cids of its cause", payload)
	}
	payload, ok, err = ViewCallEvent("probe-surface", "probe", json.RawMessage(`{"id":9,"command":"demo.run","params":null}`))
	if err != nil || !ok {
		t.Fatalf("call request without cids: ok %v, err %v", ok, err)
	}
	if _, has := payload["cids"]; has {
		t.Fatalf("forwarded call %v carries cids without a cause", payload)
	}
	if _, _, err := ViewCallEvent("probe-surface", "probe", json.RawMessage(`{"id":10,"command":"demo.run","params":null,"cids":["p1.7\"x"]}`)); err == nil || err.Error() != "probe-surface: view call 10 cids must be non-empty strings without a quote, a backslash or a control character" {
		t.Fatalf("call request with an invalid cid: %v, want the cids refusal", err)
	}
}

// contract: view.call.forward
func TestViewCallInvalidRequestsAreErrorsNotForwarded(t *testing.T) {
	for _, message := range []string{
		`{"id":"7","cancel":true}`,
		`{"id":7,"cancel":false}`,
		`{"id":7,"cancel":true,"command":"tab.state.read"}`,
		`{"command":"tab.state.read"}`,
		`{"id":"7","command":"tab.state.read"}`,
		`{"id":7,"command":""}`,
	} {
		payload, _, err := ViewCallEvent("probe-surface", "probe", json.RawMessage(message))
		if err == nil {
			t.Fatalf("message %s is accepted as %v, want an error", message, payload)
		}
		if payload != nil {
			t.Fatalf("message %s returns payload %v with its error", message, payload)
		}
	}
}

// contract: view.event.push
func TestViewEventPostsTheEventWithItsDataToTheReadyDocument(t *testing.T) {
	s, fake := newViewChannelSurfaces(t)
	if err := s.pushViewEvent(ViewEventRequest{Surface: "probe-surface", Event: "probe.changed", Data: json.RawMessage(`{"count":1}`)}); err == nil || err.Error() != "probe-surface has no ready document" {
		t.Fatalf("event before ready: %v, want probe-surface has no ready document", err)
	}
	ready := `{"message":{"event":"view.ready","plugin":"probe","document":"doc-1"}}`
	if err := s.viewMessage("probe-surface", ready); err != nil {
		t.Fatalf("ready message: %v", err)
	}
	before := len(fake.posted)
	if err := s.pushViewEvent(ViewEventRequest{Surface: "probe-surface", Event: "probe.changed", Data: json.RawMessage(`{"count":2}`)}); err != nil {
		t.Fatalf("event: %v", err)
	}
	if len(fake.posted) != before+1 {
		t.Fatalf("events posted: %d, want 1", len(fake.posted)-before)
	}
	var posted map[string]any
	if err := json.Unmarshal([]byte(fake.posted[len(fake.posted)-1]), &posted); err != nil {
		t.Fatalf("event message is not JSON: %v", err)
	}
	if posted["sok"] != float64(1) || posted["event"] != "probe.changed" || !reflect.DeepEqual(posted["data"], map[string]any{"count": float64(2)}) {
		t.Fatalf("event message %v, want sok 1, event probe.changed and the data", posted)
	}
	if err := s.pushViewEvent(ViewEventRequest{Surface: "probe-surface", Event: "", Data: json.RawMessage(`null`)}); err == nil || err.Error() != "view event has an empty event name" {
		t.Fatalf("event without a name: %v, want view event has an empty event name", err)
	}
	if err := s.pushViewEvent(ViewEventRequest{Surface: "probe-surface", Event: "probe.changed"}); err == nil || err.Error() != "view event probe.changed has no data" {
		t.Fatalf("event without data: %v, want view event probe.changed has no data", err)
	}
}

// contract: view.command.request
func TestViewCommandRequestPostsTheRequestToTheReadyDocument(t *testing.T) {
	s, fake := newViewChannelSurfaces(t)
	request := ViewRequestRequest{Surface: "probe-surface", ID: 7, Command: "probe.run", Params: json.RawMessage(`{"a":1}`)}
	if err := s.pushViewRequest(request); err == nil || err.Error() != "probe-surface has no ready document" {
		t.Fatalf("request before ready: %v, want probe-surface has no ready document", err)
	}
	ready := `{"message":{"event":"view.ready","plugin":"probe","document":"doc-1"}}`
	if err := s.viewMessage("probe-surface", ready); err != nil {
		t.Fatalf("ready message: %v", err)
	}
	before := len(fake.posted)
	if err := s.pushViewRequest(request); err != nil {
		t.Fatalf("request: %v", err)
	}
	if len(fake.posted) != before+1 {
		t.Fatalf("requests posted: %d, want 1", len(fake.posted)-before)
	}
	var posted map[string]any
	if err := json.Unmarshal([]byte(fake.posted[len(fake.posted)-1]), &posted); err != nil {
		t.Fatalf("request message is not JSON: %v", err)
	}
	if posted["sok"] != float64(1) || posted["id"] != float64(7) || posted["command"] != "probe.run" || !reflect.DeepEqual(posted["params"], map[string]any{"a": float64(1)}) {
		t.Fatalf("request message %v, want sok 1, id 7, command probe.run and the params", posted)
	}
	if err := s.pushViewRequest(ViewRequestRequest{Surface: "probe-surface", ID: 0, Command: "probe.run"}); err == nil || err.Error() != "view request has no id" {
		t.Fatalf("request without an id: %v, want view request has no id", err)
	}
	if err := s.pushViewRequest(ViewRequestRequest{Surface: "probe-surface", ID: 8, Command: ""}); err == nil || err.Error() != "view request 8 has an empty command" {
		t.Fatalf("request without a command: %v, want view request 8 has an empty command", err)
	}
	// A request that carries the cids of its cause posts them with the request, and a request without cids posts no member.
	var caused ViewRequestRequest
	if err := json.Unmarshal([]byte(`{"surface":"probe-surface","id":9,"command":"probe.run","params":null,"cids":["p1700000000000.7"]}`), &caused); err != nil {
		t.Fatalf("request with cids: %v", err)
	}
	before = len(fake.posted)
	if err := s.pushViewRequest(caused); err != nil {
		t.Fatalf("request with cids: %v", err)
	}
	var withCids map[string]any
	if err := json.Unmarshal([]byte(fake.posted[len(fake.posted)-1]), &withCids); err != nil {
		t.Fatalf("request message with cids is not JSON: %v", err)
	}
	if !reflect.DeepEqual(withCids["cids"], []any{"p1700000000000.7"}) {
		t.Fatalf("request message %v, want the cids of its cause", withCids)
	}
	if err := s.pushViewRequest(request); err != nil {
		t.Fatalf("request without cids: %v", err)
	}
	var withoutCids map[string]any
	if err := json.Unmarshal([]byte(fake.posted[len(fake.posted)-1]), &withoutCids); err != nil {
		t.Fatalf("request message without cids is not JSON: %v", err)
	}
	if _, ok := withoutCids["cids"]; ok {
		t.Fatalf("request message %v carries cids without a cause", withoutCids)
	}
	var refused ViewRequestRequest
	if err := json.Unmarshal([]byte(`{"surface":"probe-surface","id":10,"command":"probe.run","cids":["p1.7\"x"]}`), &refused); err != nil {
		t.Fatalf("request with an invalid cid: %v", err)
	}
	if err := s.pushViewRequest(refused); err == nil || err.Error() != "view request 10 cids must be non-empty strings without a quote, a backslash or a control character" {
		t.Fatalf("request with an invalid cid: %v, want the cids refusal", err)
	}
}

// contract: view.command.request
func TestViewCommandReplyIsForwardedAsAViewReplyEvent(t *testing.T) {
	payload, ok, err := ViewReplyEvent("probe-surface", "probe", json.RawMessage(`{"sok":1,"reply":7,"result":{"n":2}}`))
	if err != nil {
		t.Fatalf("reply: %v", err)
	}
	if !ok {
		t.Fatalf("a reply is not forwarded")
	}
	if payload["surface"] != "probe-surface" || payload["plugin"] != "probe" || payload["id"] != uint64(7) || !reflect.DeepEqual(payload["result"], json.RawMessage(`{"n":2}`)) {
		t.Fatalf("forwarded reply %v, want surface probe-surface, plugin probe, id 7 and the result", payload)
	}
	payload, ok, err = ViewReplyEvent("probe-surface", "probe", json.RawMessage(`{"sok":1,"reply":8,"error":{"code":-32000,"message":"boom"}}`))
	if err != nil || !ok {
		t.Fatalf("error reply: ok %v, err %v", ok, err)
	}
	if !reflect.DeepEqual(payload["error"], ViewReplyError{Code: -32000, Message: "boom"}) || payload["id"] != uint64(8) {
		t.Fatalf("forwarded error reply %v, want id 8 and the error", payload)
	}
	if _, ok, _ := ViewReplyEvent("probe-surface", "probe", json.RawMessage(`{"event":"view.ready"}`)); ok {
		t.Fatalf("a ready message is forwarded as a reply")
	}
	for _, message := range []string{
		`{"reply":"7","result":1}`,
		`{"reply":7}`,
		`{"reply":7,"result":1,"error":{"code":1,"message":"x"}}`,
		`{"reply":7,"error":{"code":1}}`,
	} {
		if _, ok, err := ViewReplyEvent("probe-surface", "probe", json.RawMessage(message)); err == nil || !ok {
			t.Fatalf("invalid reply %s: ok %v, err %v, want an error", message, ok, err)
		}
	}
}

// The dom composition kind is removed: the reader refuses it with an error that names the plugin and the manifest field.
// contract: view.composition.dom-removed
func TestDomCompositionIsRefusedWithThePluginAndTheField(t *testing.T) {
	err := validateComposition("probe", SurfaceComposition{Kind: "dom"})
	want := "plugin probe surface composition: kind dom is removed; the composition takes kind view or hybrid"
	if err == nil || err.Error() != want {
		t.Fatalf("dom composition error %v, want %q", err, want)
	}
}
