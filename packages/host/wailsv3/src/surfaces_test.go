package host

import (
	"encoding/json"
	"errors"
	"fmt"
	"reflect"
	"strings"
	"testing"
	"time"
	"unsafe"

	"github.com/soksak-app/core/packages/host/wailsv3/src/platform"
)

// contract: surface-layout.continuous-waits-for-app-dom
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
	case <-time.After(time.Second):
		t.Fatal("continuous layout did not register root-view presentation")
	}
	select {
	case phase := <-phases:
		if phase != "dom" {
			t.Fatalf("continuous layout reached %s before the controlled DOM presentation callback", phase)
		}
	case <-time.After(time.Second):
		t.Fatal("continuous layout did not request DOM presentation")
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

// contract: surface-layout.continuous-presentation-failures-stop-before-commit
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
	oldSystem := system
	clock := &surfaceDispatchClockPlatform{Platform: oldSystem, times: []uint64{100, 120, 140, 200, 220, 240, 300, 320}}
	system = clock
	t.Cleanup(func() { system = oldSystem })
	ticket := uint64(41)
	var phases []string
	dispatch := func(task func()) {
		phases = append(phases, "entered")
		task()
		phases = append(phases, "returned")
	}
	if err := runSurfaceDispatch(dispatch, "main", &ticket, "present", "present-prepare-ui", func() error {
		phases = append(phases, "prepare")
		return nil
	}); err != nil {
		t.Fatalf("run ticketed dispatch: %v", err)
	}
	if err := runSurfaceDispatch(dispatch, "main", nil, "sync", "sync-layout-ui", func() error {
		phases = append(phases, "sync")
		return nil
	}); err != nil {
		t.Fatalf("run unassigned-ticket dispatch: %v", err)
	}
	observeSurfaceCallback("main", &ticket, "present", "present-dom-callback", 280, true, func() {
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
	performanceOn.Store(false)
	if err := runSurfaceDispatch(dispatch, "main", nil, "sync", "sync-layout-ui", func() error { return nil }); err != nil {
		t.Fatalf("run untraced dispatch: %v", err)
	}
	if clock.reads != 8 || len(bufferedTraces(t, "host.trace.surface.dispatch")) != 3 {
		t.Fatalf("disabled trace read clock or emitted a record: clock reads=%d records=%d", clock.reads, len(bufferedTraces(t, "host.trace.surface.dispatch")))
	}
}

type surfaceDispatchClockPlatform struct {
	platform.Platform
	times []uint64
	reads int
}

func (p *surfaceDispatchClockPlatform) MonotonicNanos() (uint64, error) {
	p.reads++
	if p.reads > len(p.times) {
		return 0, fmt.Errorf("unexpected monotonic clock read %d", p.reads)
	}
	return p.times[p.reads-1], nil
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
	surface := Surface{ID: "tab-unannounced", Visible: true, Plugin: "page", Composition: composition, Start: &ViewStart{Origin: json.RawMessage(`{"directory":null}`)}, Rect: Rect{W: 10, H: 10}}
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
	s := &Surfaces{documents: NewDocuments(), events: func(string, any) {}}
	if err := s.attachView("probe-surface", unsafe.Pointer(new(int)), "/config/document-data", "/plugins/probe", "probe", "ui/page.html", "channel-script", nullOriginStart()); err != nil {
		t.Fatalf("attach view: %v", err)
	}
	if len(fake.created) != 1 || fake.created[0].channel != "channel-script" || fake.created[0].plugin != "probe" || fake.created[0].folder != "/plugins/probe" {
		t.Fatalf("created documents: %+v, want one view configuration of plugin probe in its folder with the channel script", fake.created)
	}
	if want := []string{"soksak://probe/ui/page.html"}; !reflect.DeepEqual(fake.loaded, want) {
		t.Fatalf("loaded addresses: %v, want %v", fake.loaded, want)
	}
	if _, err := s.documents.Get(DocumentKey{Surface: "probe-surface", Name: viewRegionName}); err != nil {
		t.Fatalf("the view is not recorded for its surface: %v", err)
	}
}

// contract: surface-layout.prepare-preserves-visible-state
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

// channelPlatform is the platform of the view channel tests. It keeps the receiver of the sok-view messages of each document and
// records each message that the host posts to a document.
type channelPlatform struct {
	viewPlatform
	receive       func(string)
	posted        []string
	postedOnUI    []bool
	messageOnSet  string
	messageOnLoad string
	beforeUITask  func()
	afterPost     func()
	rejectPost    bool
	// tasks is the number of UI-thread tasks running now, which runUITask counts.
	tasks int
}

// uiFake is a test platform whose native posts record whether they run within a UI-thread task.
type uiFake interface {
	platform.Platform
	runUITask(task func())
}

// runUITask is the UI-thread runner of a test Surfaces. It runs the task on the calling goroutine and counts the task while it runs.
func (p *channelPlatform) runUITask(task func()) {
	p.tasks++
	defer func() { p.tasks-- }()
	if before := p.beforeUITask; before != nil {
		p.beforeUITask = nil
		before()
	}
	task()
}

func (p *channelPlatform) LoadDocument(document unsafe.Pointer, url string) bool {
	p.viewPlatform.LoadDocument(document, url)
	if p.messageOnLoad != "" && p.receive != nil {
		p.receive(p.messageOnLoad)
	}
	return true
}

func (p *channelPlatform) SetViewMessage(document unsafe.Pointer, message func(value string)) error {
	p.receive = message
	if p.messageOnSet != "" {
		message(p.messageOnSet)
	}
	return nil
}

func (p *channelPlatform) PostDocument(document unsafe.Pointer, value string) bool {
	p.posted = append(p.posted, value)
	p.postedOnUI = append(p.postedOnUI, p.tasks > 0)
	if p.afterPost != nil {
		p.afterPost()
	}
	return !p.rejectPost
}

// contract: view.source-registration-precedes-provider-messages
func TestViewSourceRegistrationPrecedesFirstSnapshotAndStatusRegistration(t *testing.T) {
	fake := &channelPlatform{
		messageOnSet:  hostMessage(`{"event":"declared-ui.snapshot","plugin":"probe","status":"lines","seq":1,"skipped":0,"value":{"text":"first"}}`),
		messageOnLoad: hostMessage(`{"id":1,"command":"runtime.native.call","plugin":"probe","params":{"name":"registered","payload":{"kind":"status","name":"probe.lines"}}}`),
	}
	saved := system
	system = fake
	t.Cleanup(func() { system = saved })
	events := []hostEvent{}
	s := &Surfaces{
		documents: NewDocuments(),
		views:     map[string]*nativeWebview{"probe-surface": {}},
		events:    func(name string, data any) { events = append(events, hostEvent{name, data}) },
	}
	if err := s.attachView("probe-surface", unsafe.Pointer(new(int)), "/config/document-data", "/plugins/probe", "probe", "ui/page.html", "channel-script", nullOriginStart()); err != nil {
		t.Fatal(err)
	}
	if len(events) < 3 || events[0].name != "declared-ui-source-registered" || events[1].name != "declared-ui-snapshot" || events[2].name != "view-call" {
		t.Fatalf("source lifecycle and first provider messages were ordered %v, want registration, snapshot, then status registration call", events)
	}
	generation := events[0].data.(map[string]any)["generation"]
	for i, event := range events[:3] {
		data, ok := event.data.(map[string]any)
		if !ok || data["plugin"] != "probe" || data["surface"] != "probe-surface" || data["generation"] != generation {
			t.Fatalf("event %d does not carry the registered view identity: %+v", i, event)
		}
	}
}

// newViewChannelSurfaces returns the surfaces of one attached view of plugin probe and the platform that records its messages.
func newViewChannelSurfaces(t *testing.T) (*Surfaces, *channelPlatform) {
	t.Helper()
	fake := &channelPlatform{}
	var _ platform.Platform = fake
	saved := system
	system = fake
	t.Cleanup(func() { system = saved })
	s := &Surfaces{documents: NewDocuments(), invoke: fake.runUITask, views: map[string]*nativeWebview{"probe-surface": {}}, events: func(string, any) {}}
	if err := s.attachView("probe-surface", unsafe.Pointer(new(int)), "/config/document-data", "/plugins/probe", "probe", "ui/page.html", "channel-script", nullOriginStart()); err != nil {
		t.Fatalf("attach view: %v", err)
	}
	return s, fake
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
	next := strings.Replace(strings.Replace(nativeViewState, `"loading":false`, `"loading":true`, 1), `"navigations":1`, `"navigations":2`, 1)
	if err := s.viewState("probe-surface", next); err != nil {
		t.Fatalf("new navigation state: %v", err)
	}
	if err := s.postView("probe-surface", map[string]any{"event": "probe"}); err == nil {
		t.Fatalf("post after navigation is accepted, want the ready record cleared")
	}
}

// contract: view.channel.progress-keeps-ready
// The view reports the progress of its load after its ready message: the navigation is the same, so the ready record stays.
func TestViewStateKeepsTheReadyDocumentThroughProgressOfTheSameNavigation(t *testing.T) {
	s, _ := newViewChannelSurfaces(t)
	// The navigation starts before the page script runs, so its state arrives before the ready message.
	start := strings.Replace(nativeViewState, `"loading":false`, `"loading":true`, 1)
	if err := s.viewState("probe-surface", start); err != nil {
		t.Fatalf("start state: %v", err)
	}
	ready := `{"message":{"event":"view.ready","plugin":"probe","document":"doc-1"}}`
	if err := s.viewMessage("probe-surface", ready); err != nil {
		t.Fatalf("ready message: %v", err)
	}
	loading := strings.Replace(nativeViewState, `"loading":false`, `"loading":true`, 1)
	if err := s.viewState("probe-surface", loading); err != nil {
		t.Fatalf("progress state: %v", err)
	}
	if err := s.postView("probe-surface", map[string]any{"event": "probe"}); err != nil {
		t.Fatalf("post after the progress of the same navigation: %v, want the ready record kept", err)
	}
}

// contract: view.channel.state-navigations-required
func TestViewStateRefusesAStateWithoutNavigationsAndALowerCount(t *testing.T) {
	s, _ := newViewChannelSurfaces(t)
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
	if err := s.replyView(ViewReplyRequest{Page: "page-1", Surface: "probe-surface", Generation: viewGeneration(s, "probe-surface"), ID: 7, Result: json.RawMessage(`{"count":2}`)}); err != nil {
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
	if err := s.replyView(ViewReplyRequest{Page: "page-1", Surface: "probe-surface", Generation: viewGeneration(s, "probe-surface"), ID: 8, Error: &ViewReplyError{Code: -32000, Message: "tab.state is not declared"}}); err != nil {
		t.Fatalf("error reply: %v", err)
	}
	var failed map[string]any
	if err := json.Unmarshal([]byte(fake.posted[len(fake.posted)-1]), &failed); err != nil {
		t.Fatalf("error reply is not JSON: %v", err)
	}
	if failed["id"] != float64(8) || failed["error"] == nil {
		t.Fatalf("error reply %v, want id 8 and the error", failed)
	}
	if err := s.replyView(ViewReplyRequest{Page: "page-1", Surface: "probe-surface", Generation: viewGeneration(s, "probe-surface"), ID: 9}); err == nil || err.Error() != "view reply 9 has neither a result nor an error" {
		t.Fatalf("reply without result or error: %v", err)
	}
}

// contract: view.call.reply
func TestViewReplyRecordsTheNativePostResultAfterPosting(t *testing.T) {
	s, fake := newViewChannelSurfaces(t)
	s.name = "main"
	const id = uint64(991)
	if err := s.viewMessage("probe-surface", `{"message":{"event":"view.ready","plugin":"probe","document":"doc-1"}}`); err != nil {
		t.Fatalf("ready message: %v", err)
	}
	before := len(fake.posted)
	postReturned := false
	fake.afterPost = func() {
		records.Lock()
		defer records.Unlock()
		for _, record := range records.buffer {
			if record.event == "host.view.reply.dispatch" && strings.Contains(string(record.fields), `"id":991`) {
				t.Fatalf("dispatch was recorded before native PostDocument returned")
			}
		}
		postReturned = true
	}
	req := ViewReplyRequest{Page: "page-1", Surface: "probe-surface", Generation: viewGeneration(s, "probe-surface"), ID: id, Result: json.RawMessage(`null`)}
	if err := s.replyView(req); err != nil {
		t.Fatalf("reply: %v", err)
	}
	if !postReturned {
		t.Fatal("native PostDocument callback did not run")
	}
	if len(fake.posted) != before+1 {
		t.Fatalf("native posts: %d, want one additional post", len(fake.posted)-before)
	}
	var found []map[string]any
	records.Lock()
	for _, record := range records.buffer {
		if record.event != "host.view.reply.dispatch" {
			continue
		}
		var fields map[string]any
		if err := json.Unmarshal(record.fields, &fields); err != nil {
			records.Unlock()
			t.Fatal(err)
		}
		if fields["id"] == float64(id) {
			found = append(found, fields)
		}
	}
	records.Unlock()
	want := map[string]any{"window": "main", "page": "page-1", "surface": "probe-surface", "generation": float64(req.Generation), "id": float64(id), "outcome": "result", "disposition": "posted"}
	if !reflect.DeepEqual(found, []map[string]any{want}) {
		t.Fatalf("dispatch records %v, want %v after native post", found, want)
	}
}

// contract: view.call.reply
func TestStaleViewReplyRecordsDiscardWithoutPosting(t *testing.T) {
	s, fake := newViewChannelSurfaces(t)
	s.name = "main"
	if err := s.viewMessage("probe-surface", `{"message":{"event":"view.ready","plugin":"probe","document":"doc-1"}}`); err != nil {
		t.Fatalf("ready message: %v", err)
	}
	before := len(fake.posted)
	const id = uint64(992)
	current := viewGeneration(s, "probe-surface")
	if err := s.replyView(ViewReplyRequest{Page: "page-1", Surface: "probe-surface", Generation: current + 1, ID: id, Result: json.RawMessage(`null`)}); err != nil {
		t.Fatalf("stale reply: %v", err)
	}
	if len(fake.posted) != before {
		t.Fatalf("stale reply posted %d messages", len(fake.posted)-before)
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
	s, fake := newViewChannelSurfaces(t)
	s.name = "main"
	if err := s.viewMessage("probe-surface", `{"message":{"event":"view.ready","plugin":"probe","document":"doc-1"}}`); err != nil {
		t.Fatalf("ready message: %v", err)
	}
	const id = uint64(994)
	if err := s.viewMessage("probe-surface", `{"message":{"sok":1,"id":994,"command":"probe.run","params":null}}`); err != nil {
		t.Fatalf("view call: %v", err)
	}
	generation := viewGeneration(s, "probe-surface")
	before := len(fake.posted)
	var callsAtProcessEnd []openViewCall
	fake.beforeUITask = func() {
		callsAtProcessEnd = s.documents.endViewCalls("probe-surface")
		if _, err := s.documents.Remove(DocumentKey{Surface: "probe-surface", Name: viewRegionName}); err != nil {
			t.Fatalf("retire old view: %v", err)
		}
		s.documents.registerView("probe-surface", "probe", generation+1, unsafe.Pointer(new(int)))
	}
	err := s.replyView(ViewReplyRequest{Page: "page-1", Surface: "probe-surface", Generation: generation, ID: id, Result: json.RawMessage(`null`)})
	if err != nil {
		t.Fatalf("reply to retired view: %v", err)
	}
	if len(fake.posted) != before {
		t.Fatalf("stale reply posted %d messages, want no native post", len(fake.posted)-before)
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
	s, _ := newViewChannelSurfaces(t)
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

// contract: view.call.reply
func TestViewReplyPostRefusalLeavesCallOpenForProcessEnd(t *testing.T) {
	s, fake := newViewChannelSurfaces(t)
	if err := s.viewMessage("probe-surface", `{"message":{"event":"view.ready","plugin":"probe","document":"doc-1"}}`); err != nil {
		t.Fatalf("ready message: %v", err)
	}
	const id = uint64(995)
	if err := s.viewMessage("probe-surface", `{"message":{"sok":1,"id":995,"command":"probe.run","params":null}}`); err != nil {
		t.Fatalf("view call: %v", err)
	}
	fake.rejectPost = true
	err := s.replyView(ViewReplyRequest{Page: "page-1", Surface: "probe-surface", Generation: viewGeneration(s, "probe-surface"), ID: id, Result: json.RawMessage(`null`)})
	if err == nil || err.Error() != "probe-surface: the view document refused the message" {
		t.Fatalf("refused view reply error: %v", err)
	}
	if calls := s.documents.endViewCalls("probe-surface"); !reflect.DeepEqual(calls, []openViewCall{{plugin: "probe", command: "probe.run", id: id}}) {
		t.Fatalf("open calls after refused post: %+v, want the unanswered view call", calls)
	}
}

// contract: view.call.reply
func TestViewReplyPostRefusalReturnsErrorWithoutPostedRecord(t *testing.T) {
	s, fake := newViewChannelSurfaces(t)
	s.name = "main"
	if err := s.viewMessage("probe-surface", `{"message":{"event":"view.ready","plugin":"probe","document":"doc-1"}}`); err != nil {
		t.Fatalf("ready message: %v", err)
	}
	fake.rejectPost = true
	const id = uint64(993)
	err := s.replyView(ViewReplyRequest{Page: "page-1", Surface: "probe-surface", Generation: viewGeneration(s, "probe-surface"), ID: id, Result: json.RawMessage(`null`)})
	if err == nil || err.Error() != "probe-surface: the view document refused the message" {
		t.Fatalf("refused post error: %v", err)
	}
	if hasViewReplyDispatch(t, id, nil) {
		t.Fatalf("refused native post emitted a dispatch record")
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
	clock := &fakeClock{}
	s, fake, _ := newLifecycleSurfaces(t, clock)
	oldGeneration := viewGeneration(s, "probe-surface")
	endView(t, s, fake)
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
func TestViewEventPostsTheEventWithItsDataToTheReadyDocument(t *testing.T) {
	s, fake := newViewChannelSurfaces(t)
	if _, err := s.pushViewEvent(ViewEventRequest{Surface: "probe-surface", Generation: viewGeneration(s, "probe-surface"), Event: "probe.changed", Data: json.RawMessage(`{"count":1}`)}); err == nil || err.Error() != "probe-surface has no ready document" {
		t.Fatalf("event before ready: %v, want probe-surface has no ready document", err)
	}
	ready := `{"message":{"event":"view.ready","plugin":"probe","document":"doc-1"}}`
	if err := s.viewMessage("probe-surface", ready); err != nil {
		t.Fatalf("ready message: %v", err)
	}
	before := len(fake.posted)
	if accepted, err := s.pushViewEvent(ViewEventRequest{Surface: "probe-surface", Generation: viewGeneration(s, "probe-surface"), Event: "probe.changed", Data: json.RawMessage(`{"count":2}`)}); err != nil || !accepted {
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
	if _, err := s.pushViewEvent(ViewEventRequest{Surface: "probe-surface", Generation: viewGeneration(s, "probe-surface"), Event: "", Data: json.RawMessage(`null`)}); err == nil || err.Error() != "view event has an empty event name" {
		t.Fatalf("event without a name: %v, want view event has an empty event name", err)
	}
	if _, err := s.pushViewEvent(ViewEventRequest{Surface: "probe-surface", Generation: viewGeneration(s, "probe-surface"), Event: "probe.changed"}); err == nil || err.Error() != "view event probe.changed has no data" {
		t.Fatalf("event without data: %v, want view event probe.changed has no data", err)
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
	s, fake := newViewChannelSurfaces(t)
	ready := `{"message":{"event":"view.ready","plugin":"probe","document":"doc-1"}}`
	if err := s.viewMessage("probe-surface", ready); err != nil {
		t.Fatalf("ready message: %v", err)
	}
	before := len(fake.posted)
	if accepted, err := s.pushViewEvent(ViewEventRequest{Surface: "probe-surface", Generation: viewGeneration(s, "probe-surface"), Event: "status", Data: json.RawMessage(`{"name":"core.grid","value":{"tabs":2}}`)}); err != nil || !accepted {
		t.Fatalf("status event: %v", err)
	}
	if len(fake.posted) != before+1 {
		t.Fatalf("events posted: %d, want 1", len(fake.posted)-before)
	}
	var posted map[string]any
	if err := json.Unmarshal([]byte(fake.posted[len(fake.posted)-1]), &posted); err != nil {
		t.Fatalf("event message is not JSON: %v", err)
	}
	if posted["sok"] != float64(1) || posted["event"] != "status" || !reflect.DeepEqual(posted["data"], map[string]any{"name": "core.grid", "value": map[string]any{"tabs": float64(2)}}) {
		t.Fatalf("event message %v, want sok 1, event status and the name and value", posted)
	}
}

// contract: view.command.request
func TestViewCommandRequestPostsTheRequestToTheReadyDocument(t *testing.T) {
	s, fake := newViewChannelSurfaces(t)
	request := ViewRequestRequest{Surface: "probe-surface", Generation: viewGeneration(s, "probe-surface"), ID: 7, Command: "probe.run", Params: json.RawMessage(`{"a":1}`)}
	if _, err := s.pushViewRequest(request); err == nil || err.Error() != "probe-surface has no ready document" {
		t.Fatalf("request before ready: %v, want probe-surface has no ready document", err)
	}
	ready := `{"message":{"event":"view.ready","plugin":"probe","document":"doc-1"}}`
	if err := s.viewMessage("probe-surface", ready); err != nil {
		t.Fatalf("ready message: %v", err)
	}
	before := len(fake.posted)
	if _, err := s.pushViewRequest(request); err != nil {
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
	if _, err := s.pushViewRequest(ViewRequestRequest{Surface: "probe-surface", Generation: viewGeneration(s, "probe-surface"), ID: 0, Command: "probe.run"}); err == nil || err.Error() != "view request has no id" {
		t.Fatalf("request without an id: %v, want view request has no id", err)
	}
	if _, err := s.pushViewRequest(ViewRequestRequest{Surface: "probe-surface", Generation: viewGeneration(s, "probe-surface"), ID: 8, Command: ""}); err == nil || err.Error() != "view request 8 has an empty command" {
		t.Fatalf("request without a command: %v, want view request 8 has an empty command", err)
	}
	// A request that carries the cids of its cause posts them with the request, and a request without cids posts no member.
	var caused ViewRequestRequest
	if err := json.Unmarshal([]byte(`{"surface":"probe-surface","generation":1,"id":9,"command":"probe.run","params":null,"cids":["p1700000000000.7"]}`), &caused); err != nil {
		t.Fatalf("request with cids: %v", err)
	}
	before = len(fake.posted)
	if _, err := s.pushViewRequest(caused); err != nil {
		t.Fatalf("request with cids: %v", err)
	}
	var withCids map[string]any
	if err := json.Unmarshal([]byte(fake.posted[len(fake.posted)-1]), &withCids); err != nil {
		t.Fatalf("request message with cids is not JSON: %v", err)
	}
	if !reflect.DeepEqual(withCids["cids"], []any{"p1700000000000.7"}) {
		t.Fatalf("request message %v, want the cids of its cause", withCids)
	}
	if _, err := s.pushViewRequest(request); err != nil {
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
	if err := json.Unmarshal([]byte(`{"surface":"probe-surface","generation":1,"id":10,"command":"probe.run","cids":["p1.7\"x"]}`), &refused); err != nil {
		t.Fatalf("request with an invalid cid: %v", err)
	}
	if _, err := s.pushViewRequest(refused); err == nil || err.Error() != "view request 10 cids must be non-empty strings without a quote, a backslash or a control character" {
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
