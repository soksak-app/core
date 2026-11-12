package host

import (
	"encoding/json"
	"fmt"
	"reflect"
	"sync"
	"testing"
	"unsafe"

	"github.com/soksak-app/core/packages/host/go/src/platform"
)

// layoutOrderPlatform is the platform of the layout order test: it runs each task at once, begins each layout at once and records, in
// their order, the layouts that begin, the frames that it sets on the surface hosts and the commits and cancels of the layouts.
type layoutOrderPlatform struct {
	platform.Platform
	mu     sync.Mutex
	events []string
	frames map[unsafe.Pointer]platform.Rect
}

func (p *layoutOrderPlatform) record(event string) {
	p.mu.Lock()
	defer p.mu.Unlock()
	p.events = append(p.events, event)
}

func (p *layoutOrderPlatform) recorded() []string {
	p.mu.Lock()
	defer p.mu.Unlock()
	return append([]string(nil), p.events...)
}

func (p *layoutOrderPlatform) EnqueueUI(task func()) error {
	task()
	return nil
}

func (*layoutOrderPlatform) MonotonicNanos() (uint64, error) { return 1, nil }

func (*layoutOrderPlatform) MainWebview(platform.Window) (unsafe.Pointer, error) {
	return unsafe.Pointer(new(byte)), nil
}

func (*layoutOrderPlatform) SetWindowOverlays(unsafe.Pointer, []platform.WindowOverlay) error {
	return nil
}

func (*layoutOrderPlatform) TitlebarHeight(platform.Window) (float64, error) { return 40, nil }

func (*layoutOrderPlatform) SetTitlebarHeight(platform.Window, float64) error { return nil }

func (*layoutOrderPlatform) WindowControls(platform.Window) (platform.Rect, error) {
	return platform.Rect{X: 8, Y: 8, W: 60, H: 16}, nil
}

func (*layoutOrderPlatform) WatchInput(platform.Window, platform.Input) (uintptr, error) {
	return 1, nil
}

func (p *layoutOrderPlatform) BeginLayout(_ platform.Window, ticket uint64, ready func(bool)) error {
	p.record(fmt.Sprintf("begin %d", ticket))
	ready(true)
	return nil
}

func (*layoutOrderPlatform) CreateSurface(platform.Window) (unsafe.Pointer, error) {
	return unsafe.Pointer(new(byte)), nil
}

func (*layoutOrderPlatform) AlignRect(_ platform.Window, at platform.Rect) (platform.Rect, float64, error) {
	return at, 2, nil
}

func (p *layoutOrderPlatform) SetSurfaceBounds(surface unsafe.Pointer, x, y, w, h float64) {
	p.mu.Lock()
	p.frames[surface] = platform.Rect{X: x, Y: y, W: w, H: h}
	p.mu.Unlock()
	p.record(fmt.Sprintf("frame %g,%g %gx%g", x, y, w, h))
}

func (p *layoutOrderPlatform) SurfaceFrame(surface unsafe.Pointer) platform.Rect {
	p.mu.Lock()
	defer p.mu.Unlock()
	return p.frames[surface]
}

func (*layoutOrderPlatform) SetSurfaceHiddenHandle(unsafe.Pointer, bool)                            {}
func (*layoutOrderPlatform) SetSurfaceAlphaHandle(unsafe.Pointer, float64)                          {}
func (*layoutOrderPlatform) PlaceDocument(unsafe.Pointer, float64, float64, float64, float64, bool) {}

func (p *layoutOrderPlatform) CommitLayout(_ platform.Window, ticket uint64) bool {
	p.record(fmt.Sprintf("commit %d", ticket))
	return true
}

func (p *layoutOrderPlatform) CancelLayoutTicket(_ platform.Window, ticket uint64) error {
	p.record(fmt.Sprintf("cancel %d", ticket))
	return nil
}

// The native content and the page of one layout reach the screen in one transaction: the preparation begins the layout of its
// ticket and sets the frame of each surface in it, the page draws that layout, and the presentation of the ticket commits it only
// after the presentation notice of the page called back, with the frame of the preparation unchanged
// (docs/spec/native-surfaces.md#acceptance-criteria).
// contract: surface-layout.commits-the-prepared-geometry-with-its-ticket
func TestTheGeometryOfAPreparationIsCommittedWithItsTicketAfterThePresentationNotice(t *testing.T) {
	fake := &layoutOrderPlatform{frames: map[unsafe.Pointer]platform.Rect{}}
	saved, savedFramework := system, framework
	system, framework = fake, stepFramework{}
	t.Cleanup(func() { system, framework = saved, savedFramework })
	window := &noticeFrontend{notices: make(chan func(error), 1)}
	s := &Surfaces{window: window, invoke: func(task func()) { task() }, views: map[string]*nativeWebview{}, named: map[uintptr]string{},
		compositions: map[string]SurfaceComposition{}, surfacePlugins: map[string]string{}, images: NewImages(), documents: NewDocuments(),
		sidecars: &Sidecars{}, sourceOrigins: newSourceOrigins()}
	composition := SurfaceComposition{Kind: "view", Page: "ui/page.html"}
	s.compositions["tab"] = composition
	// The page of the window is ready, so the preparation emits no page-ready.
	s.first.Do(func() {})
	s.surfacePlugins["tab"] = "p"
	key := DocumentKey{Surface: "tab", Name: viewRegionName}
	if err := s.documents.Reserve(key); err != nil {
		t.Fatal(err)
	}
	s.documents.Set(key, unsafe.Pointer(new(byte)))
	slot := Rect{X: 10, Y: 20, W: 300, H: 200}
	prepared, err := s.SyncSurfaces(SyncRequest{Titlebar: 40, Settled: true, Surfaces: []Surface{
		{ID: "tab", Visible: true, Plugin: "p", Rect: slot, Composition: composition, Start: &ViewStart{Origin: json.RawMessage(`{"directory":null}`), Diagnostics: json.RawMessage(`null`), Section: json.RawMessage(`null`)}},
	}})
	if err != nil {
		t.Fatalf("the preparation failed: %v", err)
	}
	frame := "frame 10,20 300x200"
	if want := []string{fmt.Sprintf("begin %d", prepared.Ticket), frame}; !reflect.DeepEqual(fake.recorded(), want) {
		t.Fatalf("the preparation made %v, want the begin of its ticket and then the frame of its surface %v", fake.recorded(), want)
	}
	if len(prepared.Placements) != 1 || prepared.Placements[0].Rect != slot {
		t.Fatalf("the preparation answers the placements %v, want the slot %v", prepared.Placements, slot)
	}
	finished := make(chan []Placement, 1)
	failed := make(chan error, 1)
	go func() {
		placed, err := s.PresentSurfaces(PresentRequest{Ticket: prepared.Ticket, Placements: prepared.Placements, Settled: true})
		if err != nil {
			failed <- err
			return
		}
		finished <- placed
	}()
	var notice func(error)
	select {
	case notice = <-window.notices:
	case err := <-failed:
		t.Fatalf("the presentation ended before it asked for the presentation notice: %v", err)
	}
	// The presentation waits for the notice: until it calls back, the layout of the ticket is neither committed nor placed again.
	if got := fake.recorded(); len(got) != 2 {
		t.Fatalf("before the presentation notice the layout made %v", got[2:])
	}
	notice(nil)
	var placed []Placement
	select {
	case placed = <-finished:
	case err := <-failed:
		t.Fatalf("the presentation failed: %v", err)
	}
	if want := []string{fmt.Sprintf("begin %d", prepared.Ticket), frame, fmt.Sprintf("commit %d", prepared.Ticket)}; !reflect.DeepEqual(fake.recorded(), want) {
		t.Fatalf("the layout made %v, want %v: the commit of the prepared ticket after the notice, with the frame of the preparation", fake.recorded(), want)
	}
	if len(placed) != 1 || placed[0].Rect != slot {
		t.Fatalf("the presentation answers the frames %v read at its commit, want the prepared slot %v", placed, slot)
	}
}
