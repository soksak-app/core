package host

import (
	"cmp"
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"reflect"
	"runtime"
	"slices"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"
	"unsafe"

	"github.com/soksak-app/core/packages/host/go/src/platform"
	support "github.com/soksak-app/core/packages/host/go/tests/platform/darwin"
)

// contract: surface-layout.joins-root-views-before-awaiting-app-dom
func TestContinuousLayoutWaitsForApplicationDOMBeforeRasterAndCommit(t *testing.T) {
	phases := make(chan string, 4)
	domRelease := make(chan struct{})
	done := make(chan error, 1)
	go func() {
		completeLayoutPresentation(func() error {
			phases <- "views"
			return nil
		}, func() error {
			phases <- "dom"
			<-domRelease
			return nil
		}, func() error {
			phases <- "raster"
			return nil
		}, func(err error) {
			if err == nil {
				phases <- "commit"
			}
			done <- err
		})
	}()
	select {
	case phase := <-phases:
		if phase != "views" {
			t.Fatalf("continuous layout reached %s before registering root-view presentation", phase)
		}
	}
	select {
	case phase := <-phases:
		if phase != "dom" {
			t.Fatalf("continuous layout reached %s before the controlled DOM presentation callback", phase)
		}
	}
	select {
	case phase := <-phases:
		t.Fatalf("continuous layout reached %s while DOM presentation was pending", phase)
	default:
	}
	close(domRelease)
	if got := <-phases; got != "raster" {
		t.Fatalf("phase after DOM presentation is %s; want raster", got)
	}
	if got := <-phases; got != "commit" {
		t.Fatalf("phase after raster readiness is %s; want commit", got)
	}
	if err := <-done; err != nil {
		t.Fatalf("layout completion returned %v", err)
	}
}

// contract: surface-layout.presentation-failure-stops-before-commit
func TestLayoutPresentationFailureSkipsLaterStages(t *testing.T) {
	domFailure := errors.New("application presentation failed")
	var rasterCalls, commitCalls int
	var got error
	completeLayoutPresentation(func() error {
		return nil
	}, func() error { return domFailure }, func() error {
		rasterCalls++
		return nil
	}, func(err error) {
		commitCalls++
		got = err
	})
	if !errors.Is(got, domFailure) || rasterCalls != 0 || commitCalls != 1 {
		t.Fatalf("DOM failure reached raster %d times and commit %d times with error %v", rasterCalls, commitCalls, got)
	}

	rasterFailure := errors.New("image raster failed")
	rasterCalls, commitCalls = 0, 0
	got = nil
	completeLayoutPresentation(func() error {
		return nil
	}, func() error { return nil }, func() error {
		rasterCalls++
		return rasterFailure
	}, func(err error) {
		commitCalls++
		got = err
	})
	if !errors.Is(got, rasterFailure) || rasterCalls != 1 || commitCalls != 1 {
		t.Fatalf("raster failure reached raster %d times and commit %d times with error %v", rasterCalls, commitCalls, got)
	}
}

// contract: surface-layout.joins-root-views-before-awaiting-app-dom
func TestLayoutRegistersRootViewsBeforeWaitingForApplicationDOM(t *testing.T) {
	var phases []string
	completeLayoutPresentation(func() error {
		phases = append(phases, "root views")
		return nil
	}, func() error {
		phases = append(phases, "dom")
		return nil
	}, func() error {
		phases = append(phases, "raster")
		return nil
	}, func(err error) {
		if err != nil {
			t.Fatalf("layout presentation failed: %v", err)
		}
		phases = append(phases, "commit")
	})
	want := []string{"root views", "dom", "raster", "commit"}
	if !reflect.DeepEqual(phases, want) {
		t.Fatalf("layout presentation phases = %v, want %v", phases, want)
	}
}

// contract: performance.surface.dispatch-records-existing-boundaries
func TestSurfaceDispatchRecordKeepsTicketAndClockBoundaries(t *testing.T) {
	isolateTraceRecords(t)
	wasOn := performanceOn.Swap(true)
	t.Cleanup(func() { performanceOn.Store(wasOn) })
	clock := &instantTable{times: []uint64{100, 120, 140, 200, 220, 240, 300, 320, 340, 360, 380}}
	ticket := uint64(41)
	var phases []string
	dispatch := func(task func()) {
		phases = append(phases, "entered")
		task()
		phases = append(phases, "returned")
	}
	if err := runSurfaceDispatch(clock.now, dispatch, "main", &ticket, "present", "present-prepare-ui", func() error {
		phases = append(phases, "prepare")
		return nil
	}); err != nil {
		t.Fatalf("run ticketed dispatch: %v", err)
	}
	if err := runSurfaceDispatch(clock.now, dispatch, "main", nil, "sync", "sync-layout-ui", func() error {
		phases = append(phases, "sync")
		return nil
	}); err != nil {
		t.Fatalf("run unassigned-ticket dispatch: %v", err)
	}
	observeSurfaceCallback(clock.now, "main", &ticket, "present", "present-dom-callback", 280, surfaceDispatchPerformance, func() {
		phases = append(phases, "callback")
	})
	if want := []string{"entered", "prepare", "returned", "entered", "sync", "returned", "callback"}; !reflect.DeepEqual(phases, want) {
		t.Fatalf("dispatch order = %v, want %v", phases, want)
	}

	got := bufferedTraces(t, "host.trace.surface.dispatch")
	if len(got) != 3 {
		t.Fatalf("surface dispatch records = %#v, want two dispatch and one callback record", got)
	}
	wantFirst := map[string]any{
		"window": "main", "ticket": float64(ticket), "operation": "present", "stage": "present-prepare-ui",
		"queued_ns": "100", "entered_ns": "120", "returned_ns": "140",
	}
	if !reflect.DeepEqual(got[0], wantFirst) {
		t.Fatalf("ticketed dispatch record = %#v, want %#v", got[0], wantFirst)
	}
	wantSecond := map[string]any{
		"window": "main", "operation": "sync", "stage": "sync-layout-ui",
		"queued_ns": "200", "entered_ns": "220", "returned_ns": "240",
	}
	if !reflect.DeepEqual(got[1], wantSecond) {
		t.Fatalf("unassigned-ticket dispatch record = %#v, want %#v", got[1], wantSecond)
	}
	wantCallback := map[string]any{
		"window": "main", "ticket": float64(ticket), "operation": "present", "stage": "present-dom-callback",
		"queued_ns": "280", "entered_ns": "300", "returned_ns": "320",
	}
	if !reflect.DeepEqual(got[2], wantCallback) {
		t.Fatalf("callback record = %#v, want %#v", got[2], wantCallback)
	}
	if clock.reads != 8 {
		t.Fatalf("monotonic clock reads = %d, want eight reads for two dispatches and one callback", clock.reads)
	}
	if frame := bufferedTraces(t, "host.frame.surface.dispatch"); len(frame) != 0 {
		t.Fatalf("performance trace emitted a duplicate frame event: %#v", frame)
	}
	performanceOn.Store(false)
	if err := runSurfaceDispatch(clock.now, dispatch, "main", nil, "sync", "sync-layout-ui", func() error { return nil }); err != nil {
		t.Fatalf("run frame-fallback dispatch: %v", err)
	}
	if clock.reads != 11 || len(bufferedTraces(t, "host.trace.surface.dispatch")) != 3 || len(bufferedTraces(t, "host.frame.surface.dispatch")) != 1 {
		t.Fatalf("frame fallback did not record exactly once: clock reads=%d call records=%d frame records=%d", clock.reads, len(bufferedTraces(t, "host.trace.surface.dispatch")), len(bufferedTraces(t, "host.frame.surface.dispatch")))
	}
}

// contract: performance.surface.dispatch-frame-fallback-is-exclusive
func TestSurfaceDispatchFrameFallbackSelectionAndDisabledClock(t *testing.T) {
	cases := []struct {
		name                     string
		performance, call, frame bool
		want                     surfaceDispatchMode
	}{
		{"performance wins when both gates are open", true, true, true, surfaceDispatchPerformance},
		{"frame fallback when call trace is gated", true, false, true, surfaceDispatchFrame},
		{"frame trace when performance is off", false, false, true, surfaceDispatchFrame},
		{"off when both gates are closed", false, false, false, surfaceDispatchOff},
	}
	for _, test := range cases {
		t.Run(test.name, func(t *testing.T) {
			reads := 0
			_, got := surfaceDispatchClockFrom(test.performance, func() bool { return test.call }, func() bool { return test.frame }, func() (uint64, bool) {
				reads++
				return 1, true
			})
			if got != test.want {
				t.Fatalf("selected dispatch mode = %v, want %v", got, test.want)
			}
			wantReads := 1
			if test.want == surfaceDispatchOff {
				wantReads = 0
			}
			if reads != wantReads {
				t.Fatalf("clock reads = %d, want %d", reads, wantReads)
			}
		})
	}
}

// contract: performance.surface.dispatch-records-frame-only-boundaries
func TestSurfaceDispatchRecordsFrameBoundariesWhenPerformanceTraceIsOff(t *testing.T) {
	isolateTraceRecords(t)
	wasOn := performanceOn.Swap(false)
	t.Cleanup(func() { performanceOn.Store(wasOn) })
	clock := &instantTable{times: []uint64{400, 420, 440}}
	if err := runSurfaceDispatch(clock.now, func(task func()) { task() }, "main", nil, "present", "present-prepare-ui", func() error {
		return nil
	}); err != nil {
		t.Fatalf("run frame-traced dispatch: %v", err)
	}
	got := bufferedTraces(t, "host.frame.surface.dispatch")
	want := []map[string]any{{
		"window": "main", "operation": "present", "stage": "present-prepare-ui",
		"queued_ns": "400", "entered_ns": "420", "returned_ns": "440",
	}}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("frame-only dispatch records = %#v, want %#v", got, want)
	}
	if clock.reads != 3 {
		t.Fatalf("monotonic clock reads = %d, want three for a frame-only dispatch", clock.reads)
	}
	if trace := bufferedTraces(t, "host.trace.surface.dispatch"); len(trace) != 0 {
		t.Fatalf("frame-only dispatch duplicated the performance event: %#v", trace)
	}
}

// instantTable is a monotonic clock whose reads return the instants of its table in order. It counts the reads, so a test checks how
// often the code under test read the clock.
type instantTable struct {
	times []uint64
	reads int
}

func (c *instantTable) now() (uint64, error) {
	c.reads++
	if c.reads > len(c.times) {
		return 0, fmt.Errorf("unexpected monotonic clock read %d", c.reads)
	}
	return c.times[c.reads-1], nil
}

// contract: input.pointer.reads-the-press-target-before-delivery
func TestAPressReadsItsTargetBeforeItsDelivery(t *testing.T) {
	var steps []string
	err := readPressThenDeliver(func() error {
		steps = append(steps, "read")
		return nil
	}, func() error {
		steps = append(steps, "deliver")
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	if !slices.Equal(steps, []string{"read", "deliver"}) {
		t.Fatalf("a layout between the delivery and the read names another view as the target of the press: %v", steps)
	}
	failed := errors.New("no window")
	delivered := false
	err = readPressThenDeliver(func() error { return failed }, func() error {
		delivered = true
		return nil
	})
	if !errors.Is(err, failed) || delivered {
		t.Fatalf("a press whose target cannot be read was delivered: %v %v", err, delivered)
	}
}

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

// contract: view.placement.requires-current-page-declaration
func TestSyncRequestRejectsAViewWithoutACurrentPageDeclaration(t *testing.T) {
	composition := SurfaceComposition{Kind: "view", Page: "ui/page.html", Regions: []SurfaceRegion{{Name: "page", Kind: "document", Input: "native"}}, Overlays: []string{}}
	surface := Surface{ID: "tab-unannounced", Visible: true, Plugin: "page", Composition: composition, Start: &ViewStart{Origin: json.RawMessage(`{"directory":null}`), Diagnostics: json.RawMessage(`null`), Section: json.RawMessage(`null`)}, Rect: Rect{W: 10, H: 10}}
	request := SyncRequest{Settled: true, Titlebar: 40, Surfaces: []Surface{surface}}
	_, err := CheckSyncRequest(request, map[string]SurfaceComposition{}, map[string]string{})
	if want := `surface "tab-unannounced" has no composition declaration in the current page`; err == nil || err.Error() != want {
		t.Fatalf("the sync check returned %v, want %q", err, want)
	}
	current := map[string]SurfaceComposition{"tab-unannounced": composition}
	plugins := map[string]string{"tab-unannounced": "page"}
	if _, err := CheckSyncRequest(request, current, plugins); err != nil {
		t.Fatalf("the current page declaration was refused: %v", err)
	}
	stale := SurfaceComposition{Kind: "view", Page: "ui/old-page.html", Regions: composition.Regions, Overlays: []string{}}
	_, err = CheckSyncRequest(request, map[string]SurfaceComposition{"tab-unannounced": stale}, plugins)
	if want := `surface "tab-unannounced" changed its composition declaration`; err == nil || err.Error() != want {
		t.Fatalf("the sync check returned %v for a stale composition, want %q", err, want)
	}
}

// contract: view.placement.retires-declarations-on-page-reload
func TestReloadRetiresThePreviousPageCompositionDeclarations(t *testing.T) {
	composition := SurfaceComposition{Kind: "view", Page: "ui/page.html"}
	s := &Surfaces{
		compositions:         map[string]SurfaceComposition{"tab-old": composition},
		surfacePlugins:       map[string]string{"tab-old": "probe"},
		compositionRevisions: map[string]uint64{"tab-old": 1},
		reloadCancelLayout:   func() error { return nil },
		reloadKeysPageEnded:  func() {},
		reloadHideSurface:    func(unsafe.Pointer, bool) {},
		reloadCloseImage:     func(unsafe.Pointer) {},
	}
	if _, err := s.reloadSurfaceDocuments(); err != nil {
		t.Fatalf("reload: %v", err)
	}
	if len(s.compositions) != 0 || len(s.surfacePlugins) != 0 || len(s.compositionRevisions) != 0 {
		t.Fatalf("previous page declarations survived reload: compositions=%v plugins=%v revisions=%v", s.compositions, s.surfacePlugins, s.compositionRevisions)
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

// contract: surface.sync.closed-window-creates-nothing
func TestClosedWindowCreatesNoModalView(t *testing.T) {
	s := &Surfaces{closed: true, invoke: func(step func()) { step() }}
	if _, err := newNativeWebview(s, nativeWebviewOptions{Name: "modal:settings"}); err == nil || err.Error() != "project window is closed" {
		t.Fatalf("closed window creation: err %v", err)
	}
}

// contract: surface.sync.closed-window-creates-nothing
func TestClosedWindowCreatesNoSurface(t *testing.T) {
	s := &Surfaces{named: map[uintptr]string{}, closed: true}
	created := false
	_, err := s.createRegisteredSurface(func(step func()) { step() }, "tab-6", func() (unsafe.Pointer, error) {
		created = true
		return unsafe.Pointer(new(int)), nil
	})
	if created {
		t.Fatal("a closed window created a native surface")
	}
	if err == nil || err.Error() != "project window is closed" {
		t.Fatalf("closed window creation: err %v", err)
	}
	if len(s.named) != 0 {
		t.Fatalf("closed window creation named %d surfaces", len(s.named))
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

// contract: view.create-loads-page, document.process-label
func TestViewSurfaceCreatesViewConfigurationAndLoadsItsPage(t *testing.T) {
	p := realViewProbe(t, Theme{}, nullOriginStart())
	opened := p.waitCall(t, "probe.opened")
	// The page of the plugin loaded from its address, and the view configuration ran the channel script before the page.
	if opened["href"] != "soksak://probe/ui/page.html" || opened["channel"] != true {
		t.Fatalf("the page of the view opened with %v, want the address soksak://probe/ui/page.html and the channel script run", opened)
	}
	if label := ProcessLabel("probe", viewRegionName); label != "soksak://plugin/probe" {
		t.Fatalf("the process label of the view is %q, want soksak://plugin/probe", label)
	}
	if _, err := p.s.documents.Get(DocumentKey{Surface: "probe-surface", Name: viewRegionName}); err != nil {
		t.Fatalf("the view is not recorded for its surface: %v", err)
	}
}

// contract: surface-layout.prepare-visible-surfaces
func TestPrepareSurfaceVisibilityPreservesVisibleAndHidesInvisible(t *testing.T) {
	cases := []struct {
		name             string
		requestedVisible bool
		initialHidden    bool
		wantHidden       bool
	}{
		{name: "existing visible", requestedVisible: true, initialHidden: false, wantHidden: false},
		{name: "new visible", requestedVisible: true, initialHidden: true, wantHidden: true},
		{name: "requested invisible", requestedVisible: false, initialHidden: false, wantHidden: true},
	}
	for _, test := range cases {
		t.Run(test.name, func(t *testing.T) {
			hidden := test.initialHidden
			prepareSurfaceVisibility(test.requestedVisible, func(next bool) { hidden = next })
			if hidden != test.wantHidden {
				t.Fatalf("prepared surface hidden state is %t; want %t", hidden, test.wantHidden)
			}
		})
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

// contract: view.composition.image-region-declares-present
func TestImageRegionDeclaresItsPresentationMode(t *testing.T) {
	compose := func(region SurfaceRegion) error {
		return validateComposition("probe", SurfaceComposition{Kind: "view", Page: "ui/page.html", Regions: []SurfaceRegion{region}, Overlays: []string{}})
	}
	for _, present := range []string{"copy", "lease"} {
		if err := compose(SurfaceRegion{Name: "view", Kind: "image", Sidecar: "probe", Present: present, Input: "dom"}); err != nil {
			t.Fatalf("image region with present %s: %v", present, err)
		}
	}
	for _, present := range []string{"", "move"} {
		err := compose(SurfaceRegion{Name: "view", Kind: "image", Sidecar: "probe", Present: present, Input: "dom"})
		if err == nil || err.Error() != `image region "view" declares present copy or lease` {
			t.Fatalf("image region with present %q: %v", present, err)
		}
	}
	err := compose(SurfaceRegion{Name: "page", Kind: "document", Present: "lease", Input: "native"})
	if err == nil || err.Error() != `document region "page" must own native input` {
		t.Fatalf("document region with present: %v", err)
	}
}

// hostEvent is one window event that the host sent to the main page in a test.
type hostEvent struct {
	name string
	data any
}

// hostMessage returns the envelope of the sok-view handler of a host page around the message value.
func hostMessage(value string) string {
	return `{"message": ` + value + `}`
}

// contract: view.source-registration-precedes-provider-messages
func TestViewSourceRegistrationPrecedesFirstStatusRegistration(t *testing.T) {
	p := realViewProbe(t, Theme{}, nullOriginStart())
	p.waitCall(t, "probe.opened")
	events := p.eventsNow()
	if len(events) < 2 || events[0].name != "view-source-registered" || events[1].name != "view-call" {
		t.Fatalf("source lifecycle and first provider messages were ordered %v, want registration, then the first call of the page", events)
	}
	generation := events[0].data.(map[string]any)["generation"]
	for i, event := range events[:2] {
		data, ok := event.data.(map[string]any)
		if !ok || data["plugin"] != "probe" || data["surface"] != "probe-surface" || data["generation"] != generation {
			t.Fatalf("event %d does not carry the registered view identity: %+v", i, event)
		}
	}
}

func viewGeneration(s *Surfaces, surface string) uint64 {
	channel, ok := s.documents.view(surface)
	if !ok {
		return 0
	}
	return channel.generation
}

// contract: view.channel.ready
func TestViewChannelRecordsReadyDocumentPostsThemeAndClearsOnNavigation(t *testing.T) {
	p := echoViewProbe(t)
	p.ready(t)
	theme := p.received()[0]
	if theme["sok"] != float64(1) || theme["event"] != "theme" {
		t.Fatalf("theme message %v, want sok 1 and event theme", theme)
	}
	if _, has := theme["theme"]; has || theme["data"] == nil {
		t.Fatalf("theme message %v, want the theme in its data field", theme)
	}
	if len(p.received()) != 1 {
		t.Fatalf("messages posted after ready: %d, want the current theme", len(p.received()))
	}
	var posted error
	p.main(func() { posted = p.s.postView("probe-surface", map[string]any{"event": "probe"}) })
	if posted != nil {
		t.Fatalf("post to a ready view: %v", posted)
	}
	p.waitReceived(t, 2)
	next := strings.Replace(strings.Replace(nativeViewState, `"loading":false`, `"loading":true`, 1), `"navigations":1`, `"navigations":2`, 1)
	if err := p.s.viewState("probe-surface", next); err != nil {
		t.Fatalf("new navigation state: %v", err)
	}
	if err := p.s.postView("probe-surface", map[string]any{"event": "probe"}); err == nil {
		t.Fatalf("post after navigation is accepted, want the ready record cleared")
	}
}

// contract: view.channel.progress-keeps-ready
// The view reports the progress of its load after its ready message: the navigation is the same, so the ready record stays.
func TestViewStateKeepsTheReadyDocumentThroughProgressOfTheSameNavigation(t *testing.T) {
	p := echoViewProbe(t)
	// The navigation starts before the page script runs, so its state arrives before the ready message.
	start := strings.Replace(nativeViewState, `"loading":false`, `"loading":true`, 1)
	if err := p.s.viewState("probe-surface", start); err != nil {
		t.Fatalf("start state: %v", err)
	}
	p.ready(t)
	loading := strings.Replace(nativeViewState, `"loading":false`, `"loading":true`, 1)
	if err := p.s.viewState("probe-surface", loading); err != nil {
		t.Fatalf("progress state: %v", err)
	}
	var posted error
	p.main(func() { posted = p.s.postView("probe-surface", map[string]any{"event": "probe"}) })
	if posted != nil {
		t.Fatalf("post after the progress of the same navigation: %v, want the ready record kept", posted)
	}
}

// contract: view.channel.state-navigations-required
func TestViewStateRefusesAStateWithoutNavigationsAndALowerCount(t *testing.T) {
	s, _, _ := newLifecycleSurfaces(t)
	without := strings.Replace(nativeViewState, `,"navigations":1`, ``, 1)
	if err := s.viewState("probe-surface", without); err == nil || err.Error() != "probe-surface: view state has no navigations" {
		t.Fatalf("state without navigations: %v, want the refusal with its text", err)
	}
	two := strings.Replace(nativeViewState, `"navigations":1`, `"navigations":2`, 1)
	if err := s.viewState("probe-surface", two); err != nil {
		t.Fatalf("state with two navigations: %v", err)
	}
	if err := s.viewState("probe-surface", nativeViewState); err == nil || err.Error() != "probe-surface: view state counts 1 navigations, below the 2 counted before" {
		t.Fatalf("state with a lower count: %v, want the refusal with its text", err)
	}
}

// nativeViewState is the document-state payload of a view as the native host sends it (docs/spec/native-surfaces.md, document-state):
// loading is a JSON boolean, and navigations counts the navigations that the view has started.
const nativeViewState = `{"url":"soksak://probe/ui/page.html","title":"probe","loading":false,"progress":1,"canGoBack":false,"canGoForward":false,"error":null,"scroll":{"x":0,"y":0},"history":{"entries":[],"index":-1},"link":"","navigations":1}`

// contract: view.channel.state-boolean
func TestViewStateAcceptsTheNativePayloadWithABooleanLoading(t *testing.T) {
	s, _, _ := newLifecycleSurfaces(t)
	if err := s.viewState("probe-surface", nativeViewState); err != nil {
		t.Fatalf("native view state: %v", err)
	}
}

// contract: view.channel.state-numeric-refused
func TestViewStateRefusesANumericLoadingWithTheSurfaceAndTheTypeError(t *testing.T) {
	s, _, _ := newLifecycleSurfaces(t)
	payload := strings.Replace(nativeViewState, `"loading":false`, `"loading":1`, 1)
	err := s.viewState("probe-surface", payload)
	if err == nil || !strings.HasPrefix(err.Error(), "probe-surface: view state is not JSON: json: cannot unmarshal number into Go struct field") {
		t.Fatalf("numeric loading: %v, want the surface and the type error", err)
	}
}

// contract: view.channel.post-before-ready
func TestViewChannelRefusesPostBeforeReadyWithItsText(t *testing.T) {
	// A view that has not reported its ready document has no document to post to: the host refuses before any native post.
	s, _, _ := newLifecycleSurfaces(t)
	err := s.postView("probe-surface", map[string]any{"event": "probe"})
	if err == nil || err.Error() != "probe-surface has no ready document" {
		t.Fatalf("post before ready: %v, want probe-surface has no ready document", err)
	}
}

// contract: view.channel.queue-full
func TestViewChannelReportsQueueFullAndForeignFrameWithTheirReasons(t *testing.T) {
	s, _, _ := newLifecycleSurfaces(t)
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
	s, views, native := newLifecycleSurfaces(t)
	for _, offset := range []time.Duration{0, 60 * time.Second, 120 * time.Second, 180 * time.Second} {
		endView(t, s, views, viewTestEpoch.Add(offset))
	}
	if len(views.created) != 4 || len(views.closed) != 4 {
		t.Fatalf("created %d views and closed %d, want the first view and three restarts, each failure closing its view", len(views.created), len(views.closed))
	}
	if _, err := s.documents.Get(DocumentKey{Surface: "probe-surface", Name: viewRegionName}); err == nil {
		t.Fatalf("a view is recorded after the restart limit")
	}
	// The tab is reopened: its surface is removed and created again, which clears the record.
	s.viewRecords().forget("probe-surface")
	// The reopened surface resolves its folder again; the test replaces the installed-plugin lookup with the same folder.
	reopened := s.viewRecords().track("probe-surface", native, "probe", "ui/page.html", true)
	reopened.directory, reopened.folder = "/config/document-data", "/plugins/probe"
	if step := views.sync(t, s, native, true, nullOriginStart()); step != viewSyncCreate {
		t.Fatalf("the synchronization after the tab is reopened planned step %d, want the creation of the view", step)
	}
	if len(views.created) != 5 {
		t.Fatalf("views created after the reopen: %d, want the view created again", len(views.created))
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

// contract: view.message.unknown-event
func TestViewMessageRefusesAnUnknownEventAndForwardsNothing(t *testing.T) {
	p := echoViewProbe(t)
	p.ready(t)
	before := len(p.eventsNow())
	err := p.message(hostMessage(`{"event":"declared-ui.snapshot","plugin":"probe","status":"probe.lines","seq":1,"value":null,"skipped":0}`))
	if err == nil || err.Error() != `probe-surface: view event "declared-ui.snapshot" is unknown` {
		t.Fatalf("unknown event: %v, want probe-surface: view event \"declared-ui.snapshot\" is unknown", err)
	}
	if events := p.eventsNow(); len(events) != before {
		t.Fatalf("an unknown event forwarded %v", events[before:])
	}
}

// contract: view.call.reply
func TestViewCallReplyReturnsThroughTheChannelPost(t *testing.T) {
	p := echoViewProbe(t)
	p.ready(t)
	before := len(p.received())
	var replied error
	p.main(func() {
		replied = p.s.replyView(ViewReplyRequest{Page: "page-1", Surface: "probe-surface", Generation: viewGeneration(p.s, "probe-surface"), ID: 7, Result: json.RawMessage(`{"count":2}`)})
	})
	if replied != nil {
		t.Fatalf("reply: %v", replied)
	}
	reply := p.waitReceived(t, before+1)[before]
	if reply["sok"] != float64(1) || reply["id"] != float64(7) || !reflect.DeepEqual(reply["result"], map[string]any{"count": float64(2)}) {
		t.Fatalf("reply %v, want sok 1, id 7 and the result", reply)
	}
	p.main(func() {
		replied = p.s.replyView(ViewReplyRequest{Page: "page-1", Surface: "probe-surface", Generation: viewGeneration(p.s, "probe-surface"), ID: 8, Error: &ViewReplyError{Code: -32000, Message: "tab.state is not declared"}})
	})
	if replied != nil {
		t.Fatalf("error reply: %v", replied)
	}
	failed := p.waitReceived(t, before+2)[before+1]
	if failed["id"] != float64(8) || failed["error"] == nil {
		t.Fatalf("error reply %v, want id 8 and the error", failed)
	}
	p.main(func() {
		replied = p.s.replyView(ViewReplyRequest{Page: "page-1", Surface: "probe-surface", Generation: viewGeneration(p.s, "probe-surface"), ID: 9})
	})
	if replied == nil || replied.Error() != "view reply 9 has neither a result nor an error" {
		t.Fatalf("reply without result or error: %v", replied)
	}
}

// contract: view.call.reply
func TestViewReplyRecordsTheNativePostResultAfterPosting(t *testing.T) {
	isolateTraceRecords(t)
	p := echoViewProbe(t)
	p.s.name = "main"
	const id = uint64(991)
	p.ready(t)
	before := len(p.received())
	req := ViewReplyRequest{Page: "page-1", Surface: "probe-surface", Generation: viewGeneration(p.s, "probe-surface"), ID: id, Result: json.RawMessage(`null`)}
	var replied error
	p.main(func() { replied = p.s.replyView(req) })
	if replied != nil {
		t.Fatalf("reply: %v", replied)
	}
	if reply := p.waitReceived(t, before+1)[before]; reply["id"] != float64(id) {
		t.Fatalf("the page received %v, want the reply %d", reply, id)
	}
	want := map[string]any{"window": "main", "page": "page-1", "surface": "probe-surface", "generation": float64(req.Generation), "id": float64(id), "outcome": "result", "disposition": "posted"}
	if !hasViewReplyDispatch(t, id, want) {
		t.Fatalf("the dispatch record of the reply that the native post accepted is missing or differs from %v", want)
	}
}

// contract: view.call.reply
func TestStaleViewReplyRecordsDiscardWithoutPosting(t *testing.T) {
	isolateTraceRecords(t)
	p := echoViewProbe(t)
	p.s.name = "main"
	p.ready(t)
	before := len(p.received())
	const id = uint64(992)
	current := viewGeneration(p.s, "probe-surface")
	var replied error
	p.main(func() {
		replied = p.s.replyView(ViewReplyRequest{Page: "page-1", Surface: "probe-surface", Generation: current + 1, ID: id, Result: json.RawMessage(`null`)})
	})
	if replied != nil {
		t.Fatalf("stale reply: %v", replied)
	}
	// The posts of the host reach the page in order, so the message that follows the stale reply reaches it first if the reply posted nothing.
	p.main(func() { replied = p.s.postView("probe-surface", map[string]any{"event": "marker"}) })
	if replied != nil {
		t.Fatalf("marker: %v", replied)
	}
	if got := p.waitReceived(t, before+1); len(got) != before+1 || got[before]["event"] != "marker" {
		t.Fatalf("the page received %v after the stale reply, want only the marker", got[before:])
	}
	if !hasViewReplyDispatch(t, id, map[string]any{
		"window": "main", "page": "page-1", "surface": "probe-surface",
		"generation": float64(current + 1), "id": float64(id), "outcome": "result",
		"disposition": "discarded", "reason": "view-generation-not-current",
	}) {
		t.Fatalf("stale reply dispatch record missing")
	}
}

// contract: view.call.reply
func TestViewReplyRetainsOpenCallWhenGenerationRetiresBeforePost(t *testing.T) {
	isolateTraceRecords(t)
	p := echoViewProbe(t)
	p.s.name = "main"
	p.ready(t)
	const id = uint64(994)
	if err := p.message(`{"message":{"sok":1,"id":994,"command":"probe.run","params":null}}`); err != nil {
		t.Fatalf("view call: %v", err)
	}
	generation := viewGeneration(p.s, "probe-surface")
	// The view retires: its calls end as the process end ends them, the end of the view closes its document, and a view of the next
	// generation replaces it in the registry.
	var callsAtProcessEnd []openViewCall
	var replied error
	p.main(func() {
		callsAtProcessEnd = p.openCalls()
		handle, err := p.s.documents.Get(DocumentKey{Surface: "probe-surface", Name: viewRegionName})
		if err != nil {
			t.Errorf("retire old view: %v", err)
			return
		}
		if _, ok := p.s.endView("probe-surface", handle, generation, time.Now(), viewClosers{document: system.CloseDocument, image: system.CloseImage}); !ok {
			t.Error("retire old view: the end of the current view was refused")
			return
		}
		p.s.documents.registerView("probe-surface", "probe", generation+1, unsafe.Pointer(new(int)))
		replied = p.s.replyView(ViewReplyRequest{Page: "page-1", Surface: "probe-surface", Generation: generation, ID: id, Result: json.RawMessage(`null`)})
	})
	if replied != nil {
		t.Fatalf("reply to retired view: %v", replied)
	}
	if !reflect.DeepEqual(callsAtProcessEnd, []openViewCall{{plugin: "probe", command: "probe.run", id: id}}) {
		t.Fatalf("open calls available to process-ended settlement: %+v, want the unanswered view call", callsAtProcessEnd)
	}
	if !hasViewReplyDispatch(t, id, map[string]any{
		"window": "main", "page": "page-1", "surface": "probe-surface",
		"generation": float64(generation), "id": float64(id), "outcome": "result",
		"disposition": "discarded", "reason": "view-generation-not-current",
	}) {
		t.Fatalf("stale reply dispatch record missing")
	}
}

// contract: view.call.reply-generation-scoped-cleanup
func TestLateOldGenerationReplyKeepsReplacementSameIDCall(t *testing.T) {
	s, _, _ := newLifecycleSurfaces(t)
	old, ok := s.documents.view("probe-surface")
	if !ok {
		t.Fatal("the initial view has no channel")
	}
	const id = uint64(996)
	if !s.documents.trackViewCall("probe-surface", old.generation, id, "old.run") {
		t.Fatal("the old generation call was not tracked")
	}
	newGeneration := old.generation + 1
	s.documents.registerView("probe-surface", old.plugin, newGeneration, unsafe.Pointer(new(int)))
	if !s.documents.trackViewCall("probe-surface", newGeneration, id, "replacement.run") {
		t.Fatal("the replacement generation call was not tracked")
	}

	s.documents.answerViewCall("probe-surface", old.generation, id)
	calls := s.documents.endViewCalls("probe-surface")
	want := []openViewCall{{plugin: old.plugin, command: "replacement.run", id: id}}
	if !reflect.DeepEqual(calls, want) {
		t.Fatalf("open calls after the old reply: %+v, want the replacement same-ID call %+v", calls, want)
	}
}

func hasViewReplyDispatch(t *testing.T, id uint64, want map[string]any) bool {
	t.Helper()
	var found []map[string]any
	records.Lock()
	defer records.Unlock()
	for _, record := range records.buffer {
		if record.event != "host.view.reply.dispatch" {
			continue
		}
		var fields map[string]any
		if err := json.Unmarshal(record.fields, &fields); err != nil {
			t.Fatalf("dispatch record is not JSON: %v", err)
		}
		if fields["id"] == float64(id) {
			found = append(found, fields)
		}
	}
	if want == nil {
		return len(found) != 0
	}
	return reflect.DeepEqual(found, []map[string]any{want})
}

// contract: view.call.reply-null-result
func TestViewReplyWithANullResultKeepsTheNullResult(t *testing.T) {
	req, err := argument[ViewReplyRequest]("request", json.RawMessage(`{"page":"page-1","surface":"probe-surface","generation":1,"id":1,"result":null}`))
	if err != nil {
		t.Fatalf("reply with a null result: %v", err)
	}
	message, err := ViewReplyMessage(req)
	if err != nil {
		t.Fatalf("reply with a null result is refused: %v", err)
	}
	if result, ok := message["result"].(json.RawMessage); !ok || string(result) != "null" {
		t.Fatalf("posted result %v, want null", message["result"])
	}
}

// contract: view.call.reply
func TestViewReplyWithoutPageIdentityIsRejected(t *testing.T) {
	_, err := ViewReplyMessage(ViewReplyRequest{
		Surface: "probe-surface", Generation: 1, ID: 1, Result: json.RawMessage(`null`),
	})
	if err == nil || err.Error() != "view reply names no page" {
		t.Fatalf("reply without page identity: %v", err)
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
	// A null cids member is not the absent member: the spec defines only an omitted list, so null is refused like any other non-list.
	if _, _, err := ViewCallEvent("probe-surface", "probe", json.RawMessage(`{"id":11,"command":"demo.run","params":null,"cids":null}`)); err == nil || err.Error() != "probe-surface: view call 11 cids must be non-empty strings without a quote, a backslash or a control character" {
		t.Fatalf("call request with null cids: %v, want the cids refusal", err)
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

// contract: view.source-generation
func TestStaleViewCommandsAreCancelledAfterTheViewRestarts(t *testing.T) {
	s, views, _ := newLifecycleSurfaces(t)
	oldGeneration := viewGeneration(s, "probe-surface")
	endView(t, s, views, viewTestEpoch)
	newGeneration := viewGeneration(s, "probe-surface")
	if newGeneration <= oldGeneration {
		t.Fatalf("replacement generation %d, want newer than %d", newGeneration, oldGeneration)
	}
	accepted, err := s.pushViewEvent(ViewEventRequest{Surface: "probe-surface", Generation: oldGeneration, Event: "status", Data: json.RawMessage(`{"name":"core.grid","value":{}}`)})
	if err != nil || accepted {
		t.Fatalf("stale event: accepted %v, error %v; want rejected without error", accepted, err)
	}
	result, err := s.pushViewRequest(ViewRequestRequest{Surface: "probe-surface", Generation: oldGeneration, ID: 1, Command: "probe.run"})
	want := map[string]any{"cancelled": true, "sourceGeneration": oldGeneration}
	if err != nil || !reflect.DeepEqual(result, want) {
		t.Fatalf("stale request: result %v, error %v; want %v without error", result, err, want)
	}
}

// contract: view.event.push
func TestViewEventKeepsANullDataAsItsValue(t *testing.T) {
	p := echoViewProbe(t)
	p.ready(t)
	before := len(p.received())
	raw := fmt.Sprintf(`{"surface":"probe-surface","generation":%d,"event":"run-start","data":null}`, viewGeneration(p.s, "probe-surface"))
	req, err := argument[ViewEventRequest]("request", json.RawMessage(raw))
	if err != nil {
		t.Fatalf("event with null data: %v", err)
	}
	var accepted bool
	var pushed error
	p.main(func() { accepted, pushed = p.s.pushViewEvent(req) })
	if pushed != nil || !accepted {
		t.Fatalf("push: accepted %v, error %v", accepted, pushed)
	}
	if got, want := p.waitReceived(t, before+1)[before], map[string]any{"data": nil, "event": "run-start", "sok": float64(1)}; !reflect.DeepEqual(got, want) {
		t.Fatalf("event message %v, want %v", got, want)
	}
	if request, err := argument[ViewRequestRequest]("request", json.RawMessage(`{"surface":"probe-surface","generation":1,"id":1,"command":"probe.run","params":null}`)); err != nil || string(request.Params) != "null" {
		t.Fatalf("request with null params: %s, error %v", request.Params, err)
	}
	if _, err := argument[ViewEventRequest]("request", json.RawMessage(`{"surface":"probe-surface","generation":1,"event":"run-start"}`)); err == nil || err.Error() != "argument request.data is missing" {
		t.Fatalf("absent data: %v, want argument request.data is missing", err)
	}
}

// contract: view.event.push
func TestViewEventPostsTheEventWithItsDataToTheReadyDocument(t *testing.T) {
	p := echoViewProbe(t)
	var accepted bool
	var pushed error
	push := func(request ViewEventRequest) {
		p.main(func() { accepted, pushed = p.s.pushViewEvent(request) })
	}
	push(ViewEventRequest{Surface: "probe-surface", Generation: viewGeneration(p.s, "probe-surface"), Event: "probe.changed", Data: json.RawMessage(`{"count":1}`)})
	if pushed == nil || pushed.Error() != "probe-surface has no ready document" {
		t.Fatalf("event before ready: %v, want probe-surface has no ready document", pushed)
	}
	p.ready(t)
	before := len(p.received())
	push(ViewEventRequest{Surface: "probe-surface", Generation: viewGeneration(p.s, "probe-surface"), Event: "probe.changed", Data: json.RawMessage(`{"count":2}`)})
	if pushed != nil || !accepted {
		t.Fatalf("event: %v", pushed)
	}
	posted := p.waitReceived(t, before+1)[before]
	if len(p.received()) != before+1 {
		t.Fatalf("events posted: %d, want 1", len(p.received())-before)
	}
	if posted["sok"] != float64(1) || posted["event"] != "probe.changed" || !reflect.DeepEqual(posted["data"], map[string]any{"count": float64(2)}) {
		t.Fatalf("event message %v, want sok 1, event probe.changed and the data", posted)
	}
	push(ViewEventRequest{Surface: "probe-surface", Generation: viewGeneration(p.s, "probe-surface"), Event: "", Data: json.RawMessage(`null`)})
	if pushed == nil || pushed.Error() != "view event has an empty event name" {
		t.Fatalf("event without a name: %v, want view event has an empty event name", pushed)
	}
	push(ViewEventRequest{Surface: "probe-surface", Generation: viewGeneration(p.s, "probe-surface"), Event: "probe.changed"})
	if pushed == nil || pushed.Error() != "view event probe.changed has no data" {
		t.Fatalf("event without data: %v, want view event probe.changed has no data", pushed)
	}
}

// contract: view.status.relay
// A status watch is forwarded as a view call with its command and params, and a status value is posted as a view event with its
// name and data. The host names neither command: it relays both unchanged (docs/spec/native-surfaces.md#view-surfaces).
func TestViewStatusWatchIsForwardedAndStatusValueIsPosted(t *testing.T) {
	message := json.RawMessage(`{"sok":1,"id":3,"command":"runtime.status.watch","params":{"name":"core.grid"}}`)
	payload, ok, err := ViewCallEvent("probe-surface", "probe", message)
	if err != nil || !ok {
		t.Fatalf("status watch: ok %v, error %v, want a forwarded call", ok, err)
	}
	forwarded, err := json.Marshal(payload)
	if err != nil {
		t.Fatalf("forwarded call is not JSON: %v", err)
	}
	if string(forwarded) != `{"command":"runtime.status.watch","id":3,"params":{"name":"core.grid"},"plugin":"probe","surface":"probe-surface"}` {
		t.Fatalf("forwarded call %s, want the command and params of the watch", forwarded)
	}
	p := echoViewProbe(t)
	p.ready(t)
	before := len(p.received())
	var accepted bool
	var pushed error
	p.main(func() {
		accepted, pushed = p.s.pushViewEvent(ViewEventRequest{Surface: "probe-surface", Generation: viewGeneration(p.s, "probe-surface"), Event: "status", Data: json.RawMessage(`{"name":"core.grid","value":{"tabs":2}}`)})
	})
	if pushed != nil || !accepted {
		t.Fatalf("status event: %v", pushed)
	}
	posted := p.waitReceived(t, before+1)[before]
	if len(p.received()) != before+1 {
		t.Fatalf("events posted: %d, want 1", len(p.received())-before)
	}
	if posted["sok"] != float64(1) || posted["event"] != "status" || !reflect.DeepEqual(posted["data"], map[string]any{"name": "core.grid", "value": map[string]any{"tabs": float64(2)}}) {
		t.Fatalf("event message %v, want sok 1, event status and the name and value", posted)
	}
}

// contract: view.command.request
func TestViewCommandRequestPostsTheRequestToTheReadyDocument(t *testing.T) {
	p := echoViewProbe(t)
	request := ViewRequestRequest{Surface: "probe-surface", Generation: viewGeneration(p.s, "probe-surface"), ID: 7, Command: "probe.run", Params: json.RawMessage(`{"a":1}`)}
	var pushed error
	push := func(request ViewRequestRequest) {
		p.main(func() { _, pushed = p.s.pushViewRequest(request) })
	}
	push(request)
	if pushed == nil || pushed.Error() != "probe-surface has no ready document" {
		t.Fatalf("request before ready: %v, want probe-surface has no ready document", pushed)
	}
	p.ready(t)
	before := len(p.received())
	push(request)
	if pushed != nil {
		t.Fatalf("request: %v", pushed)
	}
	posted := p.waitReceived(t, before+1)[before]
	if posted["sok"] != float64(1) || posted["id"] != float64(7) || posted["command"] != "probe.run" || !reflect.DeepEqual(posted["params"], map[string]any{"a": float64(1)}) {
		t.Fatalf("request message %v, want sok 1, id 7, command probe.run and the params", posted)
	}
	push(ViewRequestRequest{Surface: "probe-surface", Generation: viewGeneration(p.s, "probe-surface"), ID: 0, Command: "probe.run"})
	if pushed == nil || pushed.Error() != "view request has no id" {
		t.Fatalf("request without an id: %v, want view request has no id", pushed)
	}
	push(ViewRequestRequest{Surface: "probe-surface", Generation: viewGeneration(p.s, "probe-surface"), ID: 8, Command: ""})
	if pushed == nil || pushed.Error() != "view request 8 has an empty command" {
		t.Fatalf("request without a command: %v, want view request 8 has an empty command", pushed)
	}
	// A request that carries the cids of its cause posts them with the request, and a request without cids posts no member.
	var caused ViewRequestRequest
	if err := json.Unmarshal([]byte(`{"surface":"probe-surface","generation":1,"id":9,"command":"probe.run","params":null,"cids":["p1700000000000.7"]}`), &caused); err != nil {
		t.Fatalf("request with cids: %v", err)
	}
	push(caused)
	if pushed != nil {
		t.Fatalf("request with cids: %v", pushed)
	}
	withCids := p.waitReceived(t, before+2)[before+1]
	if !reflect.DeepEqual(withCids["cids"], []any{"p1700000000000.7"}) {
		t.Fatalf("request message %v, want the cids of its cause", withCids)
	}
	push(request)
	if pushed != nil {
		t.Fatalf("request without cids: %v", pushed)
	}
	withoutCids := p.waitReceived(t, before+3)[before+2]
	if _, ok := withoutCids["cids"]; ok {
		t.Fatalf("request message %v carries cids without a cause", withoutCids)
	}
	var refused ViewRequestRequest
	if err := json.Unmarshal([]byte(`{"surface":"probe-surface","generation":1,"id":10,"command":"probe.run","cids":["p1.7\"x"]}`), &refused); err != nil {
		t.Fatalf("request with an invalid cid: %v", err)
	}
	push(refused)
	if pushed == nil || pushed.Error() != "view request 10 cids must be non-empty strings without a quote, a backslash or a control character" {
		t.Fatalf("request with an invalid cid: %v, want the cids refusal", pushed)
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
	want := "plugin probe surface composition: kind dom is removed; the composition takes kind view"
	if err == nil || err.Error() != want {
		t.Fatalf("dom composition error %v, want %q", err, want)
	}
}

// The hybrid composition kind is removed: the reader refuses it, whether or not it is complete, with the same error as the dom kind.
// contract: view.composition.dom-removed
func TestHybridCompositionIsRefusedWithThePluginAndTheField(t *testing.T) {
	document := SurfaceRegion{Name: "page", Kind: "document", Input: "native"}
	for _, composition := range []SurfaceComposition{
		{Kind: "hybrid", Regions: []SurfaceRegion{document}, Overlays: []string{}},
		{Kind: "hybrid", Page: "ui/page.html", Regions: []SurfaceRegion{document}, Overlays: []string{}},
	} {
		err := validateComposition("probe", composition)
		want := "plugin probe surface composition: kind hybrid is removed; the composition takes kind view"
		if err == nil || err.Error() != want {
			t.Fatalf("hybrid composition %+v error %v, want %q", composition, err, want)
		}
	}
}

// noticeFrontend is the window of a layout test: it hands each presentation notice that the library asks for to the test.
type noticeFrontend struct {
	frontendRecord
	notices chan func(error)
}

func (*noticeFrontend) NativeWindow() platform.Window { return 1 }

func (f *noticeFrontend) AfterPresentation(done func(error)) error {
	f.notices <- done
	return nil
}

// useStepFramework makes framework a stepFramework for the test t and restores the framework of the package at its end.
func useStepFramework(t *testing.T) {
	t.Helper()
	saved := framework
	framework = stepFramework{}
	t.Cleanup(func() { framework = saved })
}

// stepFramework is the framework of a layout test: it runs each step at once.
type stepFramework struct{ frameworkRecord }

func (stepFramework) Step(task func()) { task() }

// nestedMainFramework is the framework of a test whose steps run on the main thread and may nest, as the step of a framework does: a step
// that a task of the main thread starts runs at once in that task.
type nestedMainFramework struct{ frameworkRecord }

// mainGoroutine is the identity of the goroutine that runs the steps of the main thread, read once by the first step.
var mainGoroutine struct {
	sync.Once
	id string
}

// goroutineID returns the identity of the calling goroutine, the number in the first line of its stack.
func goroutineID() string {
	buffer := make([]byte, 64)
	buffer = buffer[:runtime.Stack(buffer, false)]
	fields := strings.Fields(string(buffer))
	return fields[1]
}

func (nestedMainFramework) Step(task func()) {
	mainGoroutine.Do(func() { runOnMainThread(func() { mainGoroutine.id = goroutineID() }) })
	if goroutineID() == mainGoroutine.id {
		task()
		return
	}
	runOnMainThread(task)
}

// realLayoutSurfaces returns the surfaces of a real window with its main page, whose window hands each presentation notice that the
// library asks for to the test, and the native window. The layouts are real transactions of the native layer, the steps run on the main
// thread, and the window cancels its open layout when the test ends.
func realLayoutSurfaces(t *testing.T) (*Surfaces, *openFrontend, platform.Window) {
	t.Helper()
	useCurrentPlatformForViews(t)
	savedFramework := framework
	framework = mainThreadFramework{}
	t.Cleanup(func() { framework = savedFramework })
	native := support.TitledWindowWithMainPage(t, runOnMainThread, 400, 300, "main-page.html")
	t.Cleanup(func() { runOnMainThread(func() { system.CancelLayout(native) }) })
	window := &openFrontend{noticeFrontend: noticeFrontend{notices: make(chan func(error), 1)}, native: native}
	s := &Surfaces{window: window, images: NewImages(), documents: NewDocuments(), sourceOrigins: newSourceOrigins()}
	// The page of the window is ready, so the preparation emits no page-ready.
	s.first.Do(func() {})
	return s, window, native
}

// presentPrepared prepares a layout of s and starts the present of its ticket. It returns the notice that the library asked for, the ticket
// and the end of the present.
func presentPrepared(t *testing.T, s *Surfaces, window *openFrontend) (func(error), uint64, chan error) {
	t.Helper()
	prepared, err := s.SyncSurfaces(SyncRequest{Titlebar: 40, Settled: true})
	if err != nil {
		t.Fatalf("the preparation failed: %v", err)
	}
	finished := make(chan error, 1)
	go func() {
		_, err := s.PresentSurfaces(PresentRequest{Ticket: prepared.Ticket, Settled: true})
		finished <- err
	}()
	select {
	case notice := <-window.notices:
		return notice, prepared.Ticket, finished
	case err := <-finished:
		t.Fatalf("the present ended without the presentation notice of the Frontend: %v", err)
	}
	return nil, 0, nil
}

// contract: performance.surface.dispatch-records-the-raster-wait
// A presentation records each of its stages with its ticket, and the entries of the stages follow the order in which they run: the
// preparation of the views, the registration and the callback of the presentation notice, the raster wait, and the commit. The
// callback of the notice and the commit hand their result on before their end, where they write their record (returned_ns,
// docs/spec/performance-trace.md), so the order of the records in the buffer, and their presence when the present answers, are
// not the order of the stages; entered_ns is.
func TestAPresentationRecordsEachOfItsStagesInOrder(t *testing.T) {
	isolateTraceRecords(t)
	performanceOn.Store(false)
	s, window, _ := realLayoutSurfaces(t)
	notice, ticket, finished := presentPrepared(t, s, window)
	notice(nil)
	if err := <-finished; err != nil {
		t.Fatalf("the present failed: %v", err)
	}
	want := []string{"present-prepare-ui", "present-dom-register-ui", "present-dom-callback", "present-raster-wait", "present-commit-ui"}
	// The callback and the commit write their records after they hand their result on, so the check waits until the buffer
	// holds a record of every stage.
	// The records of the preparation of the ticket are in the buffer too: the stages of the present are the records of that operation.
	var records []map[string]any
	for count := len(want); len(records) < len(want); count++ {
		records = nil
		for _, record := range awaitTraces(t, "host.frame.surface.dispatch", count) {
			if record["operation"] == "present" {
				records = append(records, record)
			}
		}
	}
	entered := func(record map[string]any) uint64 {
		text, _ := record["entered_ns"].(string)
		value, err := strconv.ParseUint(text, 10, 64)
		if err != nil {
			t.Fatalf("a presentation record has no entered_ns: %#v", record)
		}
		return value
	}
	slices.SortStableFunc(records, func(a, b map[string]any) int { return cmp.Compare(entered(a), entered(b)) })
	var stages []string
	for _, record := range records {
		if record["operation"] != "present" || fmt.Sprint(record["ticket"]) != fmt.Sprint(ticket) {
			t.Fatalf("a presentation record names another operation or ticket: %#v", record)
		}
		stages = append(stages, record["stage"].(string))
	}
	if !reflect.DeepEqual(stages, want) {
		t.Fatalf("the presentation recorded the stages %v by their entries, want %v", stages, want)
	}
}

// contract: performance.surface.dispatch-records-the-raster-wait
// The raster stage of a presentation records when its refresh started, when its wait started and when the wait ended, also for a
// wait that fails, and a refresh that fails starts no wait and records nothing.
func TestTheRasterWaitOfAPresentationRecordsItsRefreshAndItsWait(t *testing.T) {
	isolateTraceRecords(t)
	wasOn := performanceOn.Swap(false)
	t.Cleanup(func() { performanceOn.Store(wasOn) })
	clock := &instantTable{times: []uint64{100, 130, 1130, 2000, 2010, 2020, 3000}}
	ticket := uint64(12)
	var steps []string
	if err := waitSurfaceRasters(clock.now, "main", &ticket, func() error {
		steps = append(steps, "refresh")
		return nil
	}, func() error {
		steps = append(steps, "wait")
		return nil
	}); err != nil {
		t.Fatalf("the raster stage failed: %v", err)
	}
	waitFailure := errors.New("the current image raster did not present")
	if err := waitSurfaceRasters(clock.now, "main", &ticket, func() error { return nil }, func() error { return waitFailure }); err != waitFailure {
		t.Fatalf("the failed wait answered %v, want %v", err, waitFailure)
	}
	refreshFailure := errors.New("the raster refresh failed")
	if err := waitSurfaceRasters(clock.now, "main", &ticket, func() error { return refreshFailure }, func() error {
		steps = append(steps, "wait after a failed refresh")
		return nil
	}); err != refreshFailure {
		t.Fatalf("the failed refresh answered %v, want %v", err, refreshFailure)
	}
	if want := []string{"refresh", "wait"}; !reflect.DeepEqual(steps, want) {
		t.Fatalf("the raster stage ran %v, want %v", steps, want)
	}
	want := []map[string]any{{
		"window": "main", "ticket": float64(ticket), "operation": "present", "stage": "present-raster-wait",
		"queued_ns": "100", "entered_ns": "130", "returned_ns": "1130",
	}, {
		"window": "main", "ticket": float64(ticket), "operation": "present", "stage": "present-raster-wait",
		"queued_ns": "2000", "entered_ns": "2010", "returned_ns": "2020",
	}}
	if got := bufferedTraces(t, "host.frame.surface.dispatch"); !reflect.DeepEqual(got, want) {
		t.Fatalf("raster stage records = %#v, want %#v", got, want)
	}
	if clock.reads != 7 {
		t.Fatalf("monotonic clock reads = %d, want three for each wait and one for the failed refresh", clock.reads)
	}
}

// contract: performance.surface.dispatch-names-its-surface
func TestSurfaceDispatchOfACompositionNamesItsSurface(t *testing.T) {
	isolateTraceRecords(t)
	wasOn := performanceOn.Swap(false)
	t.Cleanup(func() { performanceOn.Store(wasOn) })
	clock := &instantTable{times: []uint64{100, 120, 140}}
	if err := runSurfaceDispatchOf(clock.now, func(task func()) { task() }, "main", "tab-1", nil, "composition", "composition-place-ui", func() error {
		return nil
	}); err != nil {
		t.Fatalf("run composition dispatch: %v", err)
	}
	want := map[string]any{
		"window": "main", "surface": "tab-1", "operation": "composition", "stage": "composition-place-ui",
		"queued_ns": "100", "entered_ns": "120", "returned_ns": "140",
	}
	if got := bufferedTraces(t, "host.frame.surface.dispatch"); len(got) != 1 || !reflect.DeepEqual(got[0], want) {
		t.Fatalf("composition dispatch records = %#v, want one record %#v", got, want)
	}
}

// A visible surface lies on the device pixels of the backing scale that the host fitted it to, and the window can change display
// before the page reads the answer, so the placement names that scale; a hidden surface is fitted to no grid and names none
// (docs/spec/native-surfaces.md).
// contract: surface-layout.placement-names-its-scale
func TestAnAlignedSurfaceNamesTheBackingScaleItWasFittedTo(t *testing.T) {
	fitted := platformRect{X: 203, Y: 636 + 2.0/3, W: 1360, H: 413}
	at, scale, err := fittedRect(fitted, 3)
	if err != nil || scale != 3 || at != Rect(fitted) {
		t.Fatalf("the surface fitted at %v and scale %v (%v), want %v at scale 3", at, scale, err, fitted)
	}
	visible, err := json.Marshal(seatedPlacement("probe", at, true, scale))
	if err != nil || !strings.Contains(string(visible), `"scale":3`) {
		t.Fatalf("the visible placement %s (%v) does not name the scale 3", visible, err)
	}
	hidden, err := json.Marshal(seatedPlacement("probe", at, false, scale))
	if err != nil || strings.Contains(string(hidden), "scale") {
		t.Fatalf("the hidden placement %s (%v) names a scale", hidden, err)
	}
}

// The trace of a placement names the scale of a visible view with its frame, so a trace shows on which device pixels the host seated
// it (docs/spec/performance-trace.md).
// contract: surface-layout.placement-names-its-scale
func TestTheTraceOfAPlacementNamesTheScaleOfAVisibleView(t *testing.T) {
	visible := seatedPlacement("probe", Rect{X: 203, Y: 553 + 2.0/3, W: 1360, H: 413}, true, 3)
	if got := surfaceRecord("placed", "probe", &visible); got["scale"] != 3.0 || got["visible"] != true {
		t.Fatalf("the trace of the visible placement is %v", got)
	}
	hidden := seatedPlacement("probe", Rect{}, false, 3)
	if got := surfaceRecord("placed", "probe", &hidden); got["scale"] != nil {
		t.Fatalf("the trace of the hidden placement names the scale %v", got["scale"])
	}
	if got := surfaceRecord("created", "probe", nil); got["scale"] != nil || got["x"] != nil {
		t.Fatalf("the trace of a created surface carries a placement: %v", got)
	}
}

// A window without a backing scale has no device pixels to fit a surface to, so the alignment fails instead of seating the surface
// on a grid that no display has.
// contract: surface-layout.placement-names-its-scale
func TestASurfaceAlignedInAWindowWithoutABackingScaleFails(t *testing.T) {
	fitted := platformRect{X: 1, Y: 2, W: 3, H: 4}
	for _, scale := range []float64{0, -1, math.NaN(), math.Inf(1)} {
		if _, _, err := fittedRect(fitted, scale); err == nil || !strings.Contains(err.Error(), "backing scale") {
			t.Fatalf("the region fitted at scale %v ended with %v, want a failure naming the backing scale", scale, err)
		}
	}
}
