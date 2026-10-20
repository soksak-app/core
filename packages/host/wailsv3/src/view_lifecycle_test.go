package host

import (
	"encoding/json"
	"testing"
	"time"
	"unsafe"
)

// fakeClock is the clock of the failures of the view tests. The test moves it with set.
type fakeClock struct {
	at time.Time
}

func (c *fakeClock) now() time.Time { return c.at }

func (c *fakeClock) set(offset time.Duration) {
	c.at = time.Unix(1_000_000, 0).Add(offset)
}

// lifecyclePlatform is the platform of the view lifecycle tests. It records each document web view that is created, closed, and given
// its end receiver, so a test can end a view the way the WebContent process ends.
type lifecyclePlatform struct {
	viewPlatform
	created []unsafe.Pointer
	// responsiveness holds the responsiveness receiver of each view.
	responsiveness map[unsafe.Pointer]func(bool)
	// createdFor is the native surface that each created view was given, in the order of created.
	createdFor []unsafe.Pointer
	closed     []unsafe.Pointer
	ended      map[unsafe.Pointer]func()
}

func (p *lifecyclePlatform) CreateDocument(surface unsafe.Pointer, directory, folder, plugin, channel string, changed func(state string)) (unsafe.Pointer, error) {
	handle := unsafe.Pointer(new(int))
	p.created = append(p.created, handle)
	p.createdFor = append(p.createdFor, surface)
	return handle, nil
}

func (p *lifecyclePlatform) SetViewMessage(document unsafe.Pointer, message func(value string)) error {
	return nil
}

func (p *lifecyclePlatform) SetViewEnded(document unsafe.Pointer, ended func()) error {
	p.ended[document] = ended
	return nil
}

func (p *lifecyclePlatform) SetViewResponsiveness(document unsafe.Pointer, responsiveness func(responsive bool)) error {
	p.responsiveness[document] = responsiveness
	return nil
}

// PostDocument accepts the message, so a ready message of the view can post the theme to it.
func (p *lifecyclePlatform) PostDocument(document unsafe.Pointer, value string) bool {
	return true
}

func (p *lifecyclePlatform) CloseDocument(document unsafe.Pointer) {
	p.closed = append(p.closed, document)
}

// newLifecycleSurfaces returns the surfaces of one view of plugin probe on surface probe-surface, created by its first sync, and the
// platform that records its documents. The clock is the clock of the lifecycle.
func newLifecycleSurfaces(t *testing.T, clock *fakeClock) (*Surfaces, *lifecyclePlatform, unsafe.Pointer) {
	t.Helper()
	fake := &lifecyclePlatform{ended: map[unsafe.Pointer]func(){}, responsiveness: map[unsafe.Pointer]func(bool){}}
	saved := system
	system = fake
	t.Cleanup(func() { system = saved })
	s := &Surfaces{documents: NewDocuments(), lifecycle: newViewLifecycle(clock.now), host: &Host{configDir: "/config"}}
	native := unsafe.Pointer(new(int))
	spec := s.viewRecords().track("probe-surface", native, "probe", "ui/page.html", true)
	spec.directory, spec.folder = "/config/document-data", "/plugins/probe"
	if err := s.syncView("probe-surface", native, "probe", "ui/page.html", true); err != nil {
		t.Fatalf("first sync of the view: %v", err)
	}
	return s, fake, native
}

// endView ends the WebContent process of the current view of the test surface, as WebKit reports it.
func endView(t *testing.T, s *Surfaces, fake *lifecyclePlatform) unsafe.Pointer {
	t.Helper()
	current := fake.created[len(fake.created)-1]
	end := fake.ended[current]
	if end == nil {
		t.Fatalf("the view has no end receiver")
	}
	end()
	return current
}

// A process end closes the view and creates it again from its record, without a sync of the workbench.
func TestViewProcessEndClosesTheViewAndCreatesItAgain(t *testing.T) {
	clock := &fakeClock{}
	s, fake, _ := newLifecycleSurfaces(t, clock)
	first := fake.created[0]
	endView(t, s, fake)
	if len(fake.closed) != 1 || fake.closed[0] != first {
		t.Fatalf("closed views after the process end: %d, want the ended view", len(fake.closed))
	}
	if len(fake.created) != 2 {
		t.Fatalf("created views after the process end: %d, want the view created again", len(fake.created))
	}
	if _, err := s.documents.Get(DocumentKey{Surface: "probe-surface", Name: viewRegionName}); err != nil {
		t.Fatalf("the view created again is not recorded: %v", err)
	}
}

// Three failures within the window restart the view three times; the fourth failure within the window stops the restarts.
func TestViewRestartStopsAtTheFourthFailureWithinTheWindow(t *testing.T) {
	clock := &fakeClock{}
	s, fake, _ := newLifecycleSurfaces(t, clock)
	for _, offset := range []time.Duration{0, 100 * time.Second, 200 * time.Second} {
		clock.set(offset)
		endView(t, s, fake)
	}
	if len(fake.created) != 4 {
		t.Fatalf("views created after three failures: %d, want the first view and three restarts", len(fake.created))
	}
	clock.set(250 * time.Second)
	endView(t, s, fake)
	if len(fake.created) != 4 {
		t.Fatalf("views created after the fourth failure: %d, want no view", len(fake.created))
	}
	if !s.viewRecords().isStopped("probe-surface") {
		t.Fatalf("the fourth failure within the window does not stop the restarts")
	}
}

// A failure older than the window is not counted, so the window slides past it.
func TestViewRestartWindowSlidesPastOldFailures(t *testing.T) {
	clock := &fakeClock{}
	s, fake, _ := newLifecycleSurfaces(t, clock)
	for _, offset := range []time.Duration{0, 100 * time.Second, 200 * time.Second} {
		clock.set(offset)
		endView(t, s, fake)
	}
	clock.set(350 * time.Second)
	endView(t, s, fake)
	if len(fake.created) != 5 || s.viewRecords().isStopped("probe-surface") {
		t.Fatalf("the failure at 350s with the failure at 0s out of the window: created %d, stopped %v; want a restart", len(fake.created), s.viewRecords().isStopped("probe-surface"))
	}
	clock.set(360 * time.Second)
	endView(t, s, fake)
	if !s.viewRecords().isStopped("probe-surface") {
		t.Fatalf("the fourth failure within 300s of 100s (100s, 200s, 350s, 360s) does not stop the restarts")
	}
}

// A stopped surface creates no view on a later sync, and its record stays until the surface is removed and opened again.
func TestViewStoppedSurfaceIsNotCreatedUntilItsRecordIsCleared(t *testing.T) {
	clock := &fakeClock{}
	s, fake, native := newLifecycleSurfaces(t, clock)
	for _, offset := range []time.Duration{0, 10 * time.Second, 20 * time.Second, 30 * time.Second} {
		clock.set(offset)
		endView(t, s, fake)
	}
	if !s.viewRecords().isStopped("probe-surface") {
		t.Fatalf("four failures within the window do not stop the restarts")
	}
	created := len(fake.created)
	if err := s.syncView("probe-surface", native, "probe", "ui/page.html", true); err != nil {
		t.Fatalf("sync of a stopped surface: %v", err)
	}
	if len(fake.created) != created {
		t.Fatalf("a sync created a view of a stopped surface: %d views, want %d", len(fake.created), created)
	}
	s.viewRecords().forget("probe-surface")
	if s.viewRecords().isStopped("probe-surface") {
		t.Fatalf("the record of the removed surface keeps its stop")
	}
}

// contract: view.restart.restores-state
// A view that is created again after its process ends keeps the surface of its record: the platform creates it for the same native
// surface, and the channel of the surface is the one of the new view, so its view calls are forwarded with the same surface.
func TestViewRestartKeepsTheSurfaceOfItsRecord(t *testing.T) {
	clock := &fakeClock{}
	s, fake, native := newLifecycleSurfaces(t, clock)
	endView(t, s, fake)
	if len(fake.createdFor) != 2 || fake.createdFor[1] != native {
		t.Fatalf("the view created again has the native surface of its record: %v, want the same surface twice", fake.createdFor)
	}
	channel, ok := s.documents.view("probe-surface")
	if !ok || channel.plugin != "probe" {
		t.Fatalf("the channel of the surface after the restart: %+v, %v; want the plugin probe", channel, ok)
	}
}

// windowEvent is one event that the surfaces of a test send to their window.
type windowEvent struct {
	name string
	data any
}

// recordWindowEvents makes the window events of s go to the returned slice.
func recordWindowEvents(s *Surfaces) *[]windowEvent {
	events := &[]windowEvent{}
	s.events = func(name string, data any) { *events = append(*events, windowEvent{name, data}) }
	return events
}

// contract: view.restart.limit-shows-error
// The fourth failure within the window sends one view-stopped event to the surface, which names the surface, the plugin and the reason.
// Failures before the fourth send nothing.
func TestViewStopSendsTheStopEventOnceToTheSurface(t *testing.T) {
	clock := &fakeClock{}
	s, fake, _ := newLifecycleSurfaces(t, clock)
	s.views = map[string]*nativeWebview{"probe-surface": {}}
	events := recordWindowEvents(s)
	for _, offset := range []time.Duration{0, 10 * time.Second, 20 * time.Second} {
		clock.set(offset)
		endView(t, s, fake)
	}
	if len(*events) != 0 {
		t.Fatalf("events after three failures: %d, want none", len(*events))
	}
	clock.set(30 * time.Second)
	endView(t, s, fake)
	if len(*events) != 1 || (*events)[0].name != "view-stopped" {
		t.Fatalf("events after the fourth failure: %+v, want one view-stopped event", *events)
	}
	payload, ok := (*events)[0].data.(map[string]any)
	if !ok {
		t.Fatalf("view-stopped payload is %T, want a map", (*events)[0].data)
	}
	if payload["surface"] != "probe-surface" || payload["plugin"] != "probe" || payload["reason"] != viewStopReason() {
		t.Fatalf("view-stopped payload %v, want surface probe-surface, plugin probe and the stop reason", payload)
	}
}

// contract: view.restart.limit-shows-error
// The stop reason names the restart window in seconds, the same text as the Tauri host.
func TestViewStopReasonNamesTheWindowInSeconds(t *testing.T) {
	const want = "the view failed 4 times within 300 seconds and is created again when its tab is reopened"
	if got := viewStopReason(); got != want {
		t.Fatalf("stop reason %q, want %q", got, want)
	}
}

// contract: view.restart.limit-shows-error
// The view-stopped payload carries the surface, the plugin and the reason.
func TestViewStoppedEventCarriesSurfaceAndReason(t *testing.T) {
	payload := viewStoppedEvent("probe-surface", "probe", "the reason")
	if payload["surface"] != "probe-surface" || payload["plugin"] != "probe" || payload["reason"] != "the reason" {
		t.Fatalf("payload %v, want surface probe-surface, plugin probe and reason the reason", payload)
	}
}

// isolateTraceRecords empties the start buffer of the records for the test, and restores it when the test ends.
func isolateTraceRecords(t *testing.T) {
	t.Helper()
	records.Lock()
	saved := records.buffer
	records.buffer = nil
	records.Unlock()
	t.Cleanup(func() {
		records.Lock()
		records.buffer = saved
		records.Unlock()
	})
}

// bufferedTraces returns the fields of each buffered record of event, in the order of the records.
func bufferedTraces(t *testing.T, event string) []map[string]any {
	t.Helper()
	records.Lock()
	defer records.Unlock()
	var found []map[string]any
	for _, record := range records.buffer {
		if record.event != event {
			continue
		}
		var fields map[string]any
		if err := json.Unmarshal(record.fields, &fields); err != nil {
			t.Fatalf("the fields of %s cannot be read: %v", event, err)
		}
		found = append(found, fields)
	}
	return found
}

// contract: view.responsiveness.relay
// An unresponsive notice of a view writes its trace and sends the view-responsiveness event to the surface, and a responsive notice
// does the same with responsive true. Neither notice closes or creates a view, because no call of the view ends.
func TestViewResponsivenessNoticeIsRelayedWithoutEndingTheView(t *testing.T) {
	isolateTraceRecords(t)
	clock := &fakeClock{}
	s, fake, _ := newLifecycleSurfaces(t, clock)
	s.views = map[string]*nativeWebview{"probe-surface": {}}
	events := recordWindowEvents(s)
	receive := fake.responsiveness[fake.created[0]]
	if receive == nil {
		t.Fatalf("the view has no responsiveness receiver")
	}
	receive(false)
	receive(true)
	if len(*events) != 2 {
		t.Fatalf("events after the two notices: %d, want one view-responsiveness event for each", len(*events))
	}
	for i, want := range []bool{false, true} {
		if (*events)[i].name != "view-responsiveness" {
			t.Fatalf("event %d is %q, want view-responsiveness", i, (*events)[i].name)
		}
		payload, ok := (*events)[i].data.(map[string]any)
		if !ok || payload["surface"] != "probe-surface" || payload["plugin"] != "probe" || payload["responsive"] != want {
			t.Fatalf("event %d payload %v, want surface probe-surface, plugin probe and responsive %v", i, (*events)[i].data, want)
		}
	}
	if len(fake.closed) != 0 || len(fake.created) != 1 {
		t.Fatalf("a responsiveness notice closed %d views and created %d, want no change", len(fake.closed), len(fake.created))
	}
	if got := bufferedTraces(t, "host.trace.view.unresponsive"); len(got) != 1 || got[0]["surface"] != "probe-surface" || got[0]["plugin"] != "probe" {
		t.Fatalf("host.trace.view.unresponsive records: %v, want one for probe-surface", got)
	}
	if got := bufferedTraces(t, "host.trace.view.responsive"); len(got) != 1 || got[0]["surface"] != "probe-surface" {
		t.Fatalf("host.trace.view.responsive records: %v, want one for probe-surface", got)
	}
}

// contract: view.process.events
// Creating a view writes host.trace.view.process-request, and only the first ready message of that view writes
// host.trace.view.process-ready.
func TestViewProcessEventsMarkTheRequestAndTheFirstReadyMessage(t *testing.T) {
	isolateTraceRecords(t)
	clock := &fakeClock{}
	s, _, _ := newLifecycleSurfaces(t, clock)
	requests := bufferedTraces(t, "host.trace.view.process-request")
	if len(requests) != 1 || requests[0]["surface"] != "probe-surface" || requests[0]["plugin"] != "probe" {
		t.Fatalf("host.trace.view.process-request records: %v, want one for probe-surface", requests)
	}
	ready := `{"message":{"sok":1,"event":"view.ready","plugin":"probe","document":"doc-1"}}`
	for i := 0; i < 2; i++ {
		if err := s.viewMessage("probe-surface", ready); err != nil {
			t.Fatalf("ready message %d: %v", i, err)
		}
	}
	readies := bufferedTraces(t, "host.trace.view.process-ready")
	if len(readies) != 1 || readies[0]["surface"] != "probe-surface" || readies[0]["plugin"] != "probe" {
		t.Fatalf("host.trace.view.process-ready records after two ready messages: %v, want one for probe-surface", readies)
	}
}
