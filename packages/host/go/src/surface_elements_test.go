package host

import (
	"errors"
	"slices"
	"sync"
	"testing"
	"unsafe"

	"github.com/soksak-app/core/packages/host/go/src/platform"
	support "github.com/soksak-app/core/packages/host/go/tests/platform/darwin"
)

// elementWindow is a window of pagelessFramework whose settled presentation fails when failing is set.
type elementWindow struct {
	pagelessWindow
	failing bool
}

func (w *elementWindow) SettledPresentation() (unsafe.Pointer, error) {
	if w.failing {
		return nil, errors.New("the window closed")
	}
	return nil, nil
}

// elementPlatform answers the platform operations of a window without a main page for the tests that name it.
type elementPlatform struct {
	pagelessPlatform
	held     []unsafe.Pointer
	settled  func(float64, error)
	titlebar int
	// heights are the title bar heights that were set at once.
	heights []float64
}

func (p *elementPlatform) RetainView(view unsafe.Pointer) { p.held = append(p.held, view) }

func (p *elementPlatform) ReleaseView(view unsafe.Pointer) {
	index := slices.Index(p.held, view)
	if index < 0 {
		panic("a view that is not held was released")
	}
	p.held = slices.Delete(p.held, index, index+1)
}

func (p *elementPlatform) SetTitlebarHeight(_ platform.Window, height float64) error {
	p.heights = append(p.heights, height)
	return nil
}

func (p *elementPlatform) StartPageTitlebar(_ platform.Window, _ uint64, _ float64, ready func(error)) error {
	p.titlebar++
	ready(nil)
	return nil
}

func (p *elementPlatform) AfterSettled(_ platform.Window, _ unsafe.Pointer, done func(float64, error)) error {
	p.settled = done
	return nil
}

// closingPlatform answers the calls of a window that opens and closes.
type closingPlatform struct{ elementPlatform }

func (p *closingPlatform) EnqueueUI(func()) error                 { return nil }
func (p *closingPlatform) EndResponderObservation(unsafe.Pointer) {}
func (p *closingPlatform) EndCursorObservation(unsafe.Pointer)    {}
func (p *closingPlatform) EndSheetObservation(unsafe.Pointer)     {}

// viewHolds is the platform of the operating system that keeps the list of the views that the host retained and did not release. Each
// call goes on to the platform of the operating system, on views that it created.
type viewHolds struct {
	platform.Platform
	mu      sync.Mutex
	held    []unsafe.Pointer
	changed chan struct{}
}

func (p *viewHolds) RetainView(view unsafe.Pointer) {
	p.mu.Lock()
	p.held = append(p.held, view)
	p.mu.Unlock()
	p.Platform.RetainView(view)
	p.wake()
}

func (p *viewHolds) ReleaseView(view unsafe.Pointer) {
	p.mu.Lock()
	index := slices.Index(p.held, view)
	if index < 0 {
		p.mu.Unlock()
		panic("a view that is not held was released")
	}
	p.held = slices.Delete(p.held, index, index+1)
	p.mu.Unlock()
	p.Platform.ReleaseView(view)
	p.wake()
}

func (p *viewHolds) wake() {
	select {
	case p.changed <- struct{}{}:
	default:
	}
}

func (p *viewHolds) heldViews() []unsafe.Pointer {
	p.mu.Lock()
	defer p.mu.Unlock()
	return slices.Clone(p.held)
}

// waitHeld returns the held views once their number is count; each retain and release wakes the wait.
func (p *viewHolds) waitHeld(count int) []unsafe.Pointer {
	for {
		if held := p.heldViews(); len(held) == count {
			return held
		}
		<-p.changed
	}
}

// settlingWindow is a window of the native pageless framework whose settled presentation is the main presentation of its native
// window, which the platform makes as the framework does. A window without a main web view has none, and the platform fails.
type settlingWindow struct {
	pagelessWindow
	closing func() bool
}

func (w *settlingWindow) SettledPresentation() (unsafe.Pointer, error) {
	return system.MainPresentation(w.native)
}
func (w *settlingWindow) OnClosing(hook func() bool) { w.closing = hook }

// elementFixture is a window of the platform of the operating system that draws its surfaces as elements, and three surface hosts of
// another window that the elements name.
type elementFixture struct {
	surfaces *Surfaces
	window   *settlingWindow
	holds    *viewHolds
	views    []unsafe.Pointer
}

// newElementFixture creates the window of the elements, with a main web view when presenting is set, so a frame can follow its change,
// and the surface hosts that the elements name, which close with the test.
func newElementFixture(t *testing.T, presenting bool) *elementFixture {
	t.Helper()
	current, err := platform.Current()
	if err != nil {
		t.Fatal(err)
	}
	previousFramework, previousSystem := framework, system
	holds := &viewHolds{Platform: current, changed: make(chan struct{}, 16)}
	framework, system = nativePagelessFramework{}, holds
	t.Cleanup(func() { framework, system = previousFramework, previousSystem })
	surfaceWindow := support.TitledWindowWithMainPage(t, runOnMainThread, 400, 300, "main-page.html")
	native := surfaceWindow
	if !presenting {
		native = support.TitledWindow(t, runOnMainThread, 400, 300)
	}
	f := &elementFixture{holds: holds, window: &settlingWindow{pagelessWindow: pagelessWindow{native: native}}}
	for range 3 {
		var view unsafe.Pointer
		var created error
		runOnMainThread(func() { view, created = current.CreateSurface(surfaceWindow) })
		if created != nil {
			t.Fatalf("create a surface host: %v", created)
		}
		t.Cleanup(func() { runOnMainThread(func() { current.CloseSurface(view) }) })
		f.views = append(f.views, view)
	}
	f.surfaces = &Surfaces{window: f.window, invoke: func(task func()) { task() }}
	f.surfaces.elements.drawn = true
	return f
}

// contract: surface-layout.element-holds-its-views-until-the-next-frame
func TestAnElementHoldsItsViewsUntilTheNextFrameAfterItLeft(t *testing.T) {
	f := newElementFixture(t, true)
	element := SurfaceElement{Surface: f.views[0], Key: f.views[1]}
	// The frame that follows the change cannot present while this step of the main thread runs.
	runOnMainThread(func() {
		f.surfaces.setElement("a", element)
		if got, ok := f.surfaces.element("a"); !ok || got != element {
			t.Errorf("the element is %v, %v", got, ok)
		}
		f.surfaces.setElement("a", SurfaceElement{})
		if _, ok := f.surfaces.element("a"); ok {
			t.Error("a frame still reads the element that left")
		}
		if held := f.holds.heldViews(); len(held) != 2 {
			t.Errorf("a frame that drew before the element left may still name its views, and %d are held", len(held))
		}
	})
	f.holds.waitHeld(0)
}

// contract: surface-layout.element-holds-its-views-until-the-next-frame
func TestAnElementOfANewViewPageReplacesTheOneOfTheEndedPage(t *testing.T) {
	f := newElementFixture(t, true)
	host, first, second := f.views[0], f.views[1], f.views[2]
	runOnMainThread(func() {
		f.surfaces.setElement("a", SurfaceElement{Surface: host, Key: first})
		f.surfaces.setElement("a", SurfaceElement{Surface: host, Key: second})
	})
	if held := f.holds.waitHeld(2); !slices.Equal(held, []unsafe.Pointer{host, second}) {
		t.Fatalf("the held views are %v", held)
	}
}

// A window without a main web view presents no frame, and the platform fails its settled presentation.
// contract: surface-layout.element-holds-its-views-until-the-next-frame
func TestAnElementReleasesItsViewsWhenNoFrameCanFollow(t *testing.T) {
	f := newElementFixture(t, false)
	runOnMainThread(func() {
		f.surfaces.setElement("a", SurfaceElement{Surface: f.views[0], Key: f.views[1]})
		f.surfaces.setElement("a", SurfaceElement{})
		if held := f.holds.heldViews(); len(held) != 0 {
			t.Errorf("%d views are held after the window closed", len(held))
		}
	})
}

// A closed window draws no frame that could still name the views of its elements, so its close hands them back after the frame
// that the window presents last.
// contract: surface-layout.element-holds-its-views-until-the-next-frame
func TestAClosedWindowReleasesTheViewsOfItsElements(t *testing.T) {
	f := newElementFixture(t, true)
	previousFramework := framework
	framework = nativePagelessFramework{pagelessFramework{window: f.window}}
	t.Cleanup(func() { framework = previousFramework })
	host := &Host{windows: map[uint]*Surfaces{}, owners: map[string]*Surfaces{}, sidecars: &Sidecars{}, quit: &Quit{}, relay: NewRelay[relayTarget]()}
	s := host.newWindow("main", "")
	s.views = map[string]*nativeWebview{"a": {owner: s}}
	s.setElement("a", SurfaceElement{Surface: f.views[0], Key: f.views[1]})
	runOnMainThread(func() {
		if f.window.closing() {
			t.Error("a window that is not ready kept its close")
		}
		if _, ok := s.element("a"); ok {
			t.Error("a frame still reads the element of a closed window")
		}
		if held := f.holds.heldViews(); len(held) != 2 {
			t.Errorf("the close waits for no frame, and %d views are held", len(held))
		}
	})
	f.holds.waitHeld(0)
}

// titlebarCalls is the platform of the operating system that records the title bar heights that the host set and the starts of the page
// title bar. Each call goes on to the platform of the operating system.
type titlebarCalls struct {
	platform.Platform
	titlebar int
	heights  []float64
}

func (p *titlebarCalls) SetTitlebarHeight(window platform.Window, height float64) error {
	p.heights = append(p.heights, height)
	return p.Platform.SetTitlebarHeight(window, height)
}

func (p *titlebarCalls) StartPageTitlebar(window platform.Window, ticket uint64, height float64, ready func(error)) error {
	p.titlebar++
	return p.Platform.StartPageTitlebar(window, ticket, height, ready)
}

// titlebarSurfaces returns the surfaces of a window of the platform of the operating system, which draws its surfaces as elements and
// has the title bar of a framework window.
func titlebarSurfaces(t *testing.T) (*Surfaces, *titlebarCalls, platform.Window) {
	t.Helper()
	current, err := platform.Current()
	if err != nil {
		t.Fatal(err)
	}
	window := support.TitledWindow(t, runOnMainThread, 400, 300)
	calls := &titlebarCalls{Platform: current}
	previousFramework, previousSystem := framework, system
	framework, system = nativePagelessFramework{}, calls
	t.Cleanup(func() { framework, system = previousFramework, previousSystem })
	surfaces := &Surfaces{window: &settlingWindow{pagelessWindow: pagelessWindow{native: window}}, invoke: func(task func()) { task() }}
	surfaces.elements.drawn = true
	return surfaces, calls, window
}

// titlebarOf reads the title bar height of the window from the platform.
func titlebarOf(t *testing.T, window platform.Window) float64 {
	t.Helper()
	var height float64
	var err error
	runOnMainThread(func() { height, err = system.TitlebarHeight(window) })
	if err != nil {
		t.Fatal(err)
	}
	return height
}

// A quit closes the last window while the start of its workbench runs, so the title bar step of a start that reaches a closed window
// leaves the native window alone and names no window, with or without a main page.
// contract: application.window.closed-start-sets-no-title-bar
func TestAStartThatReachesAClosedWindowSetsNoTitleBar(t *testing.T) {
	for _, drawn := range []bool{true, false} {
		surfaces, calls, window := titlebarSurfaces(t)
		surfaces.elements.drawn = drawn
		before := titlebarOf(t, window)
		mainThreadStep(func() { surfaces.closed = true })
		if err := surfaces.startTitlebar(Record{"textSize": 2.0}); !errors.Is(err, ErrNoStartWindow) {
			t.Fatalf("the start of a closed window (elements drawn %v) ended with %v, want %v", drawn, err, ErrNoStartWindow)
		}
		if len(calls.heights) != 0 || calls.titlebar != 0 || titlebarOf(t, window) != before {
			t.Fatalf("the start of a closed window (elements drawn %v) set the title bar %v and asked for the page title bar %d times", drawn, calls.heights, calls.titlebar)
		}
	}
}

// contract: surface-layout.element-holds-its-views-until-the-next-frame
func TestAWindowWithAMainPageHasNoElements(t *testing.T) {
	surfaces := &Surfaces{invoke: func(task func()) { task() }}
	surfaces.setElement("a", SurfaceElement{Surface: unsafe.Pointer(new(byte))})
	if _, ok := surfaces.element("a"); ok {
		t.Fatal("a window with a main page has an element")
	}
}

// A window without a main page has no first row to wait for: a window that shows no frame yet takes the row of the common settings at
// once, and the workbench gives each later row with its layout. A window that shows the last frame of its previous workbench keeps
// the title bar of that frame until the first screen of the new workbench, which gives its row with its layout; its start still
// checks the setting.
// contract: application.window.no-main-page-starts-without-the-page-title-bar
func TestAWindowWithoutAMainPageStartsWithoutThePageTitleBar(t *testing.T) {
	for _, shown := range []bool{false, true} {
		surfaces, calls, window := titlebarSurfaces(t)
		if err := surfaces.startWorkbenchTitlebar(Record{"textSize": 2.0}, shown); err != nil {
			t.Fatal(err)
		}
		if calls.titlebar != 0 {
			t.Fatal("the start asked for the title bar of a main page")
		}
		want := []float64{72}
		if shown {
			want = nil
		}
		if !slices.Equal(calls.heights, want) {
			t.Fatalf("the start of a window that shows a frame %t set the title bar to %v, want %v", shown, calls.heights, want)
		}
		if !shown {
			if got := titlebarOf(t, window); got != 72 {
				t.Fatalf("the window has the title bar %v after the start, want 72", got)
			}
		}
		if err := surfaces.startWorkbenchTitlebar(Record{"textSize": "2"}, shown); err == nil ||
			err.Error() != "common setting textSize must be a number, not a string" {
			t.Fatalf("the start of a window that shows a frame %t took the text size \"2\" with %v", shown, err)
		}
	}
}
