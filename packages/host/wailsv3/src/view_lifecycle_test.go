package host

import (
	"encoding/json"
	"reflect"
	"testing"
	"time"
	"unsafe"
)

// contract: host.view.killed.is-written-on-every-end
func TestAViewEndStoresHostViewKilledWithItsPluginAndSurface(t *testing.T) {
	kill, closed, untracked := t.Name()+"-kill", t.Name()+"-close", t.Name()+"-untracked"
	l := newViewLifecycle(time.Now)
	// A view that ends by a kill (its process ended) and a view that ends with its surface (a close).
	l.track(kill, nil, "probe", "ui/page.html", true)
	l.recordEnd(kill)
	l.track(closed, nil, "probe", "ui/page.html", true)
	l.recordEnd(closed)
	l.forget(closed)
	// A surface without a view stores nothing, and a view that already ended stores nothing again.
	l.recordEnd(untracked)
	l.recordEnd(closed)
	l.recordEnd(kill)
	var got []map[string]any
	records.Lock()
	for _, record := range records.buffer {
		if record.event != "host.view.killed" {
			continue
		}
		var fields map[string]any
		if err := json.Unmarshal(record.fields, &fields); err != nil {
			records.Unlock()
			t.Fatal(err)
		}
		if fields["surface"] == kill || fields["surface"] == closed || fields["surface"] == untracked {
			got = append(got, fields)
		}
	}
	records.Unlock()
	want := []map[string]any{
		{"plugin": "probe", "surface": kill, "unsent": true},
		{"plugin": "probe", "surface": closed, "unsent": true},
	}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("host.view.killed records %v, want %v", got, want)
	}
}

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
	// scripts holds the user scripts that each document received, and loadsBeforeScript the number of loads at each of them.
	scripts           map[unsafe.Pointer][]string
	loadsBeforeScript []int
	// createdFor is the native surface that each created view was given, in the order of created.
	createdFor []unsafe.Pointer
	closed     []unsafe.Pointer
	// closedImages holds the image regions that were closed, in order.
	closedImages []unsafe.Pointer
	ended        map[unsafe.Pointer]func()
	// joins holds the native joins of the views, in the order of their joins.
	joins []*viewJoin
}

// viewJoin is one join of a view to a layout transaction. abandons counts the calls of its abandon.
type viewJoin struct {
	window    unsafe.Pointer
	ticket    uint64
	view      unsafe.Pointer
	presented func()
	abandons  int
}

// JoinView records the join and returns the function that counts its abandon.
func (p *lifecyclePlatform) JoinView(window unsafe.Pointer, ticket uint64, view unsafe.Pointer, presented func()) (func() error, bool, error) {
	join := &viewJoin{window: window, ticket: ticket, view: view, presented: presented}
	p.joins = append(p.joins, join)
	return func() error {
		join.abandons++
		return nil
	}, true, nil
}

// EnqueueUI runs the function at once, because the test runs on the only thread.
func (p *lifecyclePlatform) EnqueueUI(run func()) error {
	run()
	return nil
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

// AddDocumentScript records the user script of each document, and the loads that the view made before it.
func (p *lifecyclePlatform) AddDocumentScript(document unsafe.Pointer, source string) error {
	p.scripts[document] = append(p.scripts[document], source)
	p.loadsBeforeScript = append(p.loadsBeforeScript, len(p.loaded))
	return nil
}

// PostDocument accepts the message, so a ready message of the view can post the theme to it.
func (p *lifecyclePlatform) PostDocument(document unsafe.Pointer, value string) bool {
	return true
}

func (p *lifecyclePlatform) CloseDocument(document unsafe.Pointer) {
	p.closed = append(p.closed, document)
}

func (p *lifecyclePlatform) CloseImage(image unsafe.Pointer) {
	p.closedImages = append(p.closedImages, image)
}

// newLifecycleSurfaces returns the surfaces of one view of plugin probe on surface probe-surface, created by its first sync, and the
// platform that records its documents. The clock is the clock of the lifecycle.
func newLifecycleSurfaces(t *testing.T, clock *fakeClock) (*Surfaces, *lifecyclePlatform, unsafe.Pointer) {
	t.Helper()
	fake := &lifecyclePlatform{ended: map[unsafe.Pointer]func(){}, responsiveness: map[unsafe.Pointer]func(bool){}, scripts: map[unsafe.Pointer][]string{}}
	saved := system
	system = fake
	t.Cleanup(func() { system = saved })
	s := &Surfaces{documents: NewDocuments(), streams: NewDocumentStreams(), images: NewImages(), lifecycle: newViewLifecycle(clock.now), host: &Host{configDir: "/config"}, invoke: func(task func()) { task() }, events: func(string, any) {}}
	native := unsafe.Pointer(new(int))
	spec := s.viewRecords().track("probe-surface", native, "probe", "ui/page.html", true)
	spec.directory, spec.folder = "/config/document-data", "/plugins/probe"
	if err := s.syncView("probe-surface", native, "probe", "ui/page.html", true, nullOriginStart()); err != nil {
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
// contract: view.restart.limit
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
// contract: view.restart.limit
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
// contract: view.restart.limit
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
// contract: view.restart.limit
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
	if err := s.syncView("probe-surface", native, "probe", "ui/page.html", true, nullOriginStart()); err != nil {
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
// Failures before the fourth send no view-stopped event; each process end still sends view-process-ended (native-surfaces.md, process end),
// so this test counts only the stop event.
func TestViewStopSendsTheStopEventOnceToTheSurface(t *testing.T) {
	clock := &fakeClock{}
	s, fake, _ := newLifecycleSurfaces(t, clock)
	s.views = map[string]*nativeWebview{"probe-surface": {}}
	events := recordWindowEvents(s)
	stopEvents := func() []windowEvent {
		var stops []windowEvent
		for _, event := range *events {
			if event.name == "view-stopped" {
				stops = append(stops, event)
			}
		}
		return stops
	}
	for _, offset := range []time.Duration{0, 10 * time.Second, 20 * time.Second} {
		clock.set(offset)
		endView(t, s, fake)
	}
	if len(stopEvents()) != 0 {
		t.Fatalf("view-stopped events after three failures: %d, want none", len(stopEvents()))
	}
	clock.set(30 * time.Second)
	endView(t, s, fake)
	stops := stopEvents()
	if len(stops) != 1 {
		t.Fatalf("view-stopped events after the fourth failure: %+v, want one", stops)
	}
	payload, ok := stops[0].data.(map[string]any)
	if !ok {
		t.Fatalf("view-stopped payload is %T, want a map", stops[0].data)
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

// contract: view.regions.close-with-process
// The regions of a view belong to the composition of its ended document, so a process end closes the document and image regions of
// the surface before the view is created again, and the new view can attach the same names again.
func TestViewProcessEndClosesTheRegionsOfItsSurface(t *testing.T) {
	clock := &fakeClock{}
	s, fake, _ := newLifecycleSurfaces(t, clock)
	documentKey := DocumentKey{Surface: "probe-surface", Name: "doc"}
	document := unsafe.Pointer(new(int))
	if err := s.documents.Reserve(documentKey); err != nil || !s.documents.Set(documentKey, document) {
		t.Fatalf("document region: %v", err)
	}
	imageKey := ImageKey{Surface: "probe-surface", Name: "picture"}
	image := unsafe.Pointer(new(int))
	if err := s.images.Reserve(imageKey, &ImageOwner{SidecarName: "@probe/sidecar"}); err != nil || !s.images.Set(imageKey, image) {
		t.Fatalf("image region: %v", err)
	}
	ended := endView(t, s, fake)
	if len(fake.closed) != 2 || fake.closed[0] != ended || fake.closed[1] != document {
		t.Fatalf("closed documents after the process end: %v, want the ended view and the document region", fake.closed)
	}
	if len(fake.closedImages) != 1 || fake.closedImages[0] != image {
		t.Fatalf("closed images after the process end: %v, want the image region", fake.closedImages)
	}
	if err := s.documents.Reserve(documentKey); err != nil {
		t.Fatalf("the new view cannot attach the document region again: %v", err)
	}
	if err := s.images.Reserve(imageKey, &ImageOwner{SidecarName: "@probe/sidecar"}); err != nil {
		t.Fatalf("the new view cannot attach the image region again: %v", err)
	}
	if len(fake.created) != 2 {
		t.Fatalf("created views after the process end: %d, want the view created again", len(fake.created))
	}
}

// contract: view.source-generation.restart-order
func TestViewProcessEndNotifiesThePageBeforeRegisteringTheReplacement(t *testing.T) {
	clock := &fakeClock{}
	s, fake, _ := newLifecycleSurfaces(t, clock)
	s.views = map[string]*nativeWebview{"probe-surface": {}}
	events := recordWindowEvents(s)
	endView(t, s, fake)
	ended, registered := -1, -1
	var endedGeneration uint64
	registrations := make([]struct {
		index      int
		generation uint64
	}, 0, 2)
	for i, event := range *events {
		switch event.name {
		case "view-process-ended":
			ended = i
			if payload, ok := event.data.(map[string]any); ok {
				var valid bool
				endedGeneration, valid = payload["generation"].(uint64)
				if !valid {
					t.Fatalf("view-process-ended payload %v has no generation", event.data)
				}
			} else {
				t.Fatalf("view-process-ended payload %T, want object", event.data)
			}
		case "declared-ui-source-registered":
			if payload, ok := event.data.(map[string]any); ok && payload["surface"] == "probe-surface" {
				generation, valid := payload["generation"].(uint64)
				if !valid {
					t.Fatalf("source registration payload %v has no generation", event.data)
				}
				registrations = append(registrations, struct {
					index      int
					generation uint64
				}{i, generation})
			}
		}
	}
	for _, event := range registrations {
		if event.generation > endedGeneration {
			registered = event.index
		}
	}
	if ended < 0 || registered < 0 || ended >= registered {
		t.Fatalf("events after view restart: %v, want view-process-ended before replacement source registration", *events)
	}
}

// A process end sends the view-process-ended event to the surface, so the page forgets the regions that the host closed with
// the view before the view is created again.
// contract: view.process-ended.forgets-regions
func TestViewProcessEndSendsTheProcessEndedEvent(t *testing.T) {
	clock := &fakeClock{}
	s, fake, _ := newLifecycleSurfaces(t, clock)
	s.views = map[string]*nativeWebview{"probe-surface": {}}
	events := recordWindowEvents(s)
	endView(t, s, fake)
	ended := 0
	for _, event := range *events {
		if event.name != "view-process-ended" {
			continue
		}
		ended++
		payload, ok := event.data.(map[string]any)
		if !ok || payload["surface"] != "probe-surface" || payload["generation"] == nil {
			t.Fatalf("view-process-ended payload %v, want the surface and generation", event.data)
		}
	}
	if ended != 1 {
		t.Fatalf("view-process-ended events after the process end: %d, want one", ended)
	}
}
