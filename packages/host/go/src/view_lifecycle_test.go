package host

import (
	"encoding/json"
	"reflect"
	"testing"
	"time"
	"unsafe"

	"github.com/soksak-app/core/packages/host/go/src/platform"
)

// contract: host.view.killed.is-written-on-every-end
func TestAViewEndStoresHostViewKilledWithItsPluginAndSurface(t *testing.T) {
	isolateTraceRecords(t)
	kill, closed, untracked := t.Name()+"-kill", t.Name()+"-close", t.Name()+"-untracked"
	l := newViewLifecycle()
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

// viewTestEpoch is the instant that the failures of the view tests are placed at, as offsets from it.
var viewTestEpoch = time.Unix(1_000_000, 0)

// lifecycleViews lists the views that a lifecycle test mounted, in order, with the native surface each was created for, and the native
// documents and images that the ends of the views closed, in the order of their closes (endView).
type lifecycleViews struct {
	created      []unsafe.Pointer
	createdFor   []unsafe.Pointer
	closed       []unsafe.Pointer
	closedImages []unsafe.Pointer
	// first is the handle of the first view that the test mounts, nil for a handle that only the host state holds.
	first unsafe.Pointer
}

// newLifecycleSurfaces returns the surfaces of one view of plugin probe on surface probe-surface, mounted as the first synchronization
// creates it, the list of the views that it mounted, and the native surface of the view.
func newLifecycleSurfaces(t *testing.T) (*Surfaces, *lifecycleViews, unsafe.Pointer) {
	t.Helper()
	return newLifecycleSurfacesWithStart(t, nullOriginStart())
}

// newLifecycleSurfacesWithStart mounts the first view with the immutable start values that the caller gives, which the view carries
// from its first load.
func newLifecycleSurfacesWithStart(t *testing.T, start ViewStart) (*Surfaces, *lifecycleViews, unsafe.Pointer) {
	t.Helper()
	return newLifecycleSurfacesOn(t, start, nil)
}

// newLifecycleSurfacesOn mounts the first view like newLifecycleSurfacesWithStart with the handle view as its document, which is the handle
// of a web view of the platform when a test hands it to the native layer; a nil view is a handle that only the host state holds.
func newLifecycleSurfacesOn(t *testing.T, start ViewStart, view unsafe.Pointer) (*Surfaces, *lifecycleViews, unsafe.Pointer) {
	t.Helper()
	s := &Surfaces{documents: NewDocuments(), streams: NewDocumentStreams(), images: NewImages(), lifecycle: newViewLifecycle(), host: &Host{configDir: "/config"}, invoke: func(task func()) { task() }, events: func(string, any) {}}
	native := unsafe.Pointer(new(int))
	spec := s.viewRecords().track("probe-surface", native, "probe", "ui/page.html", true)
	spec.directory, spec.folder = "/config/document-data", "/plugins/probe"
	views := &lifecycleViews{first: view}
	views.sync(t, s, native, true, start)
	return s, views, native
}

// sync runs the planned step of the synchronization of the view of the test surface: a view that does not exist is mounted the way the
// creation of a view records it, with the handle that the platform returns as a value. It returns the planned step.
func (v *lifecycleViews) sync(t *testing.T, s *Surfaces, native unsafe.Pointer, visible bool, start ViewStart) viewSync {
	t.Helper()
	return v.syncSurface(t, s, "probe-surface", native, visible, start)
}

// syncSurface runs the planned step of the synchronization of the view of surface, as sync does for the test surface.
func (v *lifecycleViews) syncSurface(t *testing.T, s *Surfaces, surface string, native unsafe.Pointer, visible bool, start ViewStart) viewSync {
	t.Helper()
	step, _, err := s.planViewSync(surface, native, "probe", "ui/page.html", visible, start)
	if err != nil {
		t.Fatalf("synchronization of the view: %v", err)
	}
	if step == viewSyncCreate {
		v.mount(t, s, surface, native, s.viewRecords().specs[surface].start)
	}
	return step
}

// mount records a created view as attachView does after the platform returned its handle.
func (v *lifecycleViews) mount(t *testing.T, s *Surfaces, surface string, native unsafe.Pointer, start ViewStart) unsafe.Pointer {
	t.Helper()
	generation, err := s.reserveView(surface)
	if err != nil {
		t.Fatalf("reserve the view: %v", err)
	}
	handle := v.first
	v.first = nil
	if handle == nil {
		handle = unsafe.Pointer(new(int))
	}
	if err := s.mountView(surface, "probe", generation, handle, start); err != nil {
		t.Fatalf("mount the view: %v", err)
	}
	s.viewLoaded(surface, native, "probe", handle)
	v.created = append(v.created, handle)
	v.createdFor = append(v.createdFor, native)
	return handle
}

// useCurrentPlatformForViews makes the platform of the operating system the platform of the host for the test. The calls that the tests of
// the views make through it name a window that has no layout transaction, which the native layer answers as it answers any window
// without one.
func useCurrentPlatformForViews(t *testing.T) {
	t.Helper()
	current, err := platform.Current()
	if err != nil {
		t.Fatalf("the platform of the operating system: %v", err)
	}
	saved := system
	system = current
	t.Cleanup(func() { system = saved })
}

// probeGeneration returns the generation of the view of the test surface, or 0 when the surface has no view.
func probeGeneration(s *Surfaces) uint64 {
	channel, _ := s.documents.view("probe-surface")
	return channel.generation
}

// endView ends the WebContent process of the current view of the test surface at the instant at, as the report of the end is handled,
// and mounts the view that the host creates again when the record of the surface allows. It returns the ended view.
func endView(t *testing.T, s *Surfaces, views *lifecycleViews, at time.Time) unsafe.Pointer {
	t.Helper()
	current := views.created[len(views.created)-1]
	channel, ok := s.documents.view("probe-surface")
	if !ok {
		t.Fatal("the view channel of the test surface is missing")
	}
	restart, ok := s.endView("probe-surface", current, channel.generation, at, viewClosers{
		document: func(handle unsafe.Pointer) { views.closed = append(views.closed, handle) },
		image:    func(handle unsafe.Pointer) { views.closedImages = append(views.closedImages, handle) },
	})
	if !ok {
		t.Fatal("the end of the current view was refused")
	}
	if restart != nil {
		if step := views.sync(t, s, restart.native, restart.visible, restart.start); step != viewSyncCreate {
			t.Fatalf("the synchronization after the end planned step %d, want the creation of the view", step)
		}
	}
	return current
}

// A process end closes the view and creates it again from its record, without a sync of the workbench.
// contract: view.restart.limit
func TestViewProcessEndClosesTheViewAndCreatesItAgain(t *testing.T) {
	s, views, _ := newLifecycleSurfaces(t)
	first := views.created[0]
	endView(t, s, views, viewTestEpoch)
	if len(views.closed) != 1 || views.closed[0] != first {
		t.Fatalf("closed views after the process end: %d, want the ended view", len(views.closed))
	}
	if len(views.created) != 2 {
		t.Fatalf("created views after the process end: %d, want the view created again", len(views.created))
	}
	if _, err := s.documents.Get(DocumentKey{Surface: "probe-surface", Name: viewRegionName}); err != nil {
		t.Fatalf("the view created again is not recorded: %v", err)
	}
}

// A ready document that the host posts the theme to is not an end of the view: the post that the host plans for it is the theme
// message, and the view is still live and has no host.view.killed record.
// contract: host.view.killed.is-written-on-every-end
func TestReadyViewDeliveryDoesNotEndTheView(t *testing.T) {
	isolateTraceRecords(t)
	s, views, _ := newLifecycleSurfaces(t)
	channel, ok := s.documents.view("probe-surface")
	if !ok {
		t.Fatal("the created view has no channel")
	}
	if !s.documents.setReadyDocument("probe-surface", channel.generation, "doc-1", 1234.5) {
		t.Fatal("the ready document was not recorded")
	}
	post, ready, stale, err := s.planViewPost("probe-surface", &channel.generation, map[string]any{"event": "theme", "data": s.Theme()})
	if err != nil || !ready || stale {
		t.Fatalf("post to the ready view: ready %v, stale %v, error %v", ready, stale, err)
	}
	if post.handle != views.created[0] {
		t.Fatalf("the post goes to the handle %p, want the view %p", post.handle, views.created[0])
	}
	var posted map[string]any
	if err := json.Unmarshal([]byte(post.text), &posted); err != nil {
		t.Fatalf("posted message %q is not JSON: %v", post.text, err)
	}
	if posted["event"] != "theme" {
		t.Fatalf("posted event %v, want theme", posted["event"])
	}
	if !s.viewRecords().live["probe-surface"] {
		t.Error("the plan of the theme post ended the view")
	}
	if got := bufferedTraces(t, "host.view.killed"); len(got) != 0 {
		t.Fatalf("host.view.killed records after the plan of a post: %v, want none", got)
	}
}

// Three failures within the window restart the view three times; the fourth failure within the window stops the restarts.
// contract: view.restart.limit
func TestViewRestartStopsAtTheFourthFailureWithinTheWindow(t *testing.T) {
	s, views, _ := newLifecycleSurfaces(t)
	for _, offset := range []time.Duration{0, 100 * time.Second, 200 * time.Second} {
		endView(t, s, views, viewTestEpoch.Add(offset))
	}
	if len(views.created) != 4 {
		t.Fatalf("views created after three failures: %d, want the first view and three restarts", len(views.created))
	}
	endView(t, s, views, viewTestEpoch.Add(250*time.Second))
	if len(views.created) != 4 {
		t.Fatalf("views created after the fourth failure: %d, want no view", len(views.created))
	}
	if !s.viewRecords().isStopped("probe-surface") {
		t.Fatalf("the fourth failure within the window does not stop the restarts")
	}
}

// A failure older than the window is not counted, so the window slides past it.
// contract: view.restart.limit
func TestViewRestartWindowSlidesPastOldFailures(t *testing.T) {
	s, views, _ := newLifecycleSurfaces(t)
	for _, offset := range []time.Duration{0, 100 * time.Second, 200 * time.Second} {
		endView(t, s, views, viewTestEpoch.Add(offset))
	}
	endView(t, s, views, viewTestEpoch.Add(350*time.Second))
	if len(views.created) != 5 || s.viewRecords().isStopped("probe-surface") {
		t.Fatalf("the failure at 350s with the failure at 0s out of the window: created %d, stopped %v; want a restart", len(views.created), s.viewRecords().isStopped("probe-surface"))
	}
	endView(t, s, views, viewTestEpoch.Add(360*time.Second))
	if !s.viewRecords().isStopped("probe-surface") {
		t.Fatalf("the fourth failure within 300s of 100s (100s, 200s, 350s, 360s) does not stop the restarts")
	}
}

// A stopped surface creates no view on a later sync, and its record stays until the surface is removed and opened again.
// contract: view.restart.limit
func TestViewStoppedSurfaceIsNotCreatedUntilItsRecordIsCleared(t *testing.T) {
	s, views, native := newLifecycleSurfaces(t)
	for _, offset := range []time.Duration{0, 10 * time.Second, 20 * time.Second, 30 * time.Second} {
		endView(t, s, views, viewTestEpoch.Add(offset))
	}
	if !s.viewRecords().isStopped("probe-surface") {
		t.Fatalf("four failures within the window do not stop the restarts")
	}
	// The synchronization of a stopped surface plans no step, so it asks nothing of the platform.
	if err := s.syncView("probe-surface", native, "probe", "ui/page.html", true, nullOriginStart()); err != nil {
		t.Fatalf("sync of a stopped surface: %v", err)
	}
	if _, ok := s.documents.view("probe-surface"); ok {
		t.Fatal("a sync created a view of a stopped surface")
	}
	if step, _, err := s.planViewSync("probe-surface", native, "probe", "ui/page.html", true, nullOriginStart()); err != nil || step != viewSyncSkip {
		t.Fatalf("the plan of the synchronization of a stopped surface: step %d, error %v; want no step", step, err)
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
	s, views, native := newLifecycleSurfaces(t)
	endView(t, s, views, viewTestEpoch)
	if len(views.createdFor) != 2 || views.createdFor[1] != native {
		t.Fatalf("the view created again has the native surface of its record: %v, want the same surface twice", views.createdFor)
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
	s, views, _ := newLifecycleSurfaces(t)
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
		endView(t, s, views, viewTestEpoch.Add(offset))
	}
	if len(stopEvents()) != 0 {
		t.Fatalf("view-stopped events after three failures: %d, want none", len(stopEvents()))
	}
	endView(t, s, views, viewTestEpoch.Add(30*time.Second))
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
	s, views, _ := newLifecycleSurfaces(t)
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
	ended := endView(t, s, views, viewTestEpoch)
	if len(views.closed) != 2 || views.closed[0] != ended || views.closed[1] != document {
		t.Fatalf("closed documents after the process end: %v, want the ended view and the document region", views.closed)
	}
	if len(views.closedImages) != 1 || views.closedImages[0] != image {
		t.Fatalf("closed images after the process end: %v, want the image region", views.closedImages)
	}
	if err := s.documents.Reserve(documentKey); err != nil {
		t.Fatalf("the new view cannot attach the document region again: %v", err)
	}
	if err := s.images.Reserve(imageKey, &ImageOwner{SidecarName: "@probe/sidecar"}); err != nil {
		t.Fatalf("the new view cannot attach the image region again: %v", err)
	}
	if len(views.created) != 2 {
		t.Fatalf("created views after the process end: %d, want the view created again", len(views.created))
	}
}

// contract: view.process-end-precedes-replacement-registration
func TestViewProcessEndNotifiesThePageBeforeRegisteringTheReplacement(t *testing.T) {
	s, views, _ := newLifecycleSurfaces(t)
	s.views = map[string]*nativeWebview{"probe-surface": {}}
	events := recordWindowEvents(s)
	endView(t, s, views, viewTestEpoch)
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
		case "view-source-registered":
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
	s, views, _ := newLifecycleSurfaces(t)
	s.views = map[string]*nativeWebview{"probe-surface": {}}
	events := recordWindowEvents(s)
	endView(t, s, views, viewTestEpoch)
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
