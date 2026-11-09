package host

import (
	"errors"
	"slices"
	"testing"
	"unsafe"

	"github.com/soksak-app/core/packages/host/go/src/platform"
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

// elementPlatform records the views that it retains and releases, and holds the settled wait until the test ends it.
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

// elements returns the surfaces of a window without a main page.
func elements(t *testing.T, window *elementWindow) (*Surfaces, *elementPlatform) {
	t.Helper()
	window.native = platform.Window(1)
	fake := &elementPlatform{}
	previousFramework, previousSystem := framework, system
	framework, system = pagelessFramework{window: window}, fake
	t.Cleanup(func() { framework, system = previousFramework, previousSystem })
	surfaces := &Surfaces{window: window, invoke: func(task func()) { task() }}
	surfaces.elements.drawn = true
	return surfaces, fake
}

// contract: surface-layout.element-holds-its-views-until-the-next-frame
func TestAnElementHoldsItsViewsUntilTheNextFrameAfterItLeft(t *testing.T) {
	surfaces, fake := elements(t, &elementWindow{})
	element := SurfaceElement{Surface: unsafe.Pointer(new(byte)), Key: unsafe.Pointer(new(byte))}
	surfaces.setElement("a", element)
	if got, ok := surfaces.element("a"); !ok || got != element {
		t.Fatalf("the element is %v, %v", got, ok)
	}
	surfaces.setElement("a", SurfaceElement{})
	if _, ok := surfaces.element("a"); ok {
		t.Fatal("a frame still reads the element that left")
	}
	if len(fake.held) != 2 {
		t.Fatalf("a frame that drew before the element left may still name its views, and %d are held", len(fake.held))
	}
	fake.settled(0, nil)
	if len(fake.held) != 0 {
		t.Fatalf("%d views are held after the next frame", len(fake.held))
	}
}

// contract: surface-layout.element-holds-its-views-until-the-next-frame
func TestAnElementOfANewViewPageReplacesTheOneOfTheEndedPage(t *testing.T) {
	surfaces, fake := elements(t, &elementWindow{})
	host, first, second := unsafe.Pointer(new(byte)), unsafe.Pointer(new(byte)), unsafe.Pointer(new(byte))
	surfaces.setElement("a", SurfaceElement{Surface: host, Key: first})
	surfaces.setElement("a", SurfaceElement{Surface: host, Key: second})
	fake.settled(0, nil)
	if !slices.Equal(fake.held, []unsafe.Pointer{host, second}) {
		t.Fatalf("the held views are %v", fake.held)
	}
}

// contract: surface-layout.element-holds-its-views-until-the-next-frame
func TestAnElementReleasesItsViewsWhenNoFrameCanFollow(t *testing.T) {
	surfaces, fake := elements(t, &elementWindow{failing: true})
	surfaces.setElement("a", SurfaceElement{Surface: unsafe.Pointer(new(byte)), Key: unsafe.Pointer(new(byte))})
	surfaces.setElement("a", SurfaceElement{})
	if len(fake.held) != 0 {
		t.Fatalf("%d views are held after the window closed", len(fake.held))
	}
}

// closingWindow is an element window that holds the hook that its close runs.
type closingWindow struct {
	elementWindow
	closing func() bool
}

func (w *closingWindow) OnClosing(hook func() bool) { w.closing = hook }

// closingPlatform answers the calls of a window that opens and closes.
type closingPlatform struct{ elementPlatform }

func (p *closingPlatform) EnqueueUI(func()) error                 { return nil }
func (p *closingPlatform) EndResponderObservation(unsafe.Pointer) {}

// A closed window draws no frame that could still name the views of its elements, so its close hands them back after the frame
// that the window can no longer present.
// contract: surface-layout.element-holds-its-views-until-the-next-frame
func TestAClosedWindowReleasesTheViewsOfItsElements(t *testing.T) {
	window := &closingWindow{elementWindow: elementWindow{pagelessWindow: pagelessWindow{native: platform.Window(1)}}}
	fake := &closingPlatform{}
	previousFramework, previousSystem := framework, system
	framework, system = pagelessFramework{window: window}, fake
	t.Cleanup(func() { framework, system = previousFramework, previousSystem })
	host := &Host{windows: map[uint]*Surfaces{}, owners: map[string]*Surfaces{}, sidecars: &Sidecars{}, quit: &Quit{}, relay: NewRelay[relayTarget]()}
	s := host.newWindow("main", "")
	s.views = map[string]*nativeWebview{"a": {owner: s}}
	s.setElement("a", SurfaceElement{Surface: unsafe.Pointer(new(byte)), Key: unsafe.Pointer(new(byte))})
	if window.closing() {
		t.Fatal("a window that is not ready kept its close")
	}
	if _, ok := s.element("a"); ok {
		t.Fatal("a frame still reads the element of a closed window")
	}
	if fake.settled == nil {
		t.Fatalf("the close waits for no frame, and %d views are held", len(fake.held))
	}
	fake.settled(0, errors.New("the window closed"))
	if len(fake.held) != 0 {
		t.Fatalf("%d views of a closed window are held", len(fake.held))
	}
}

// A quit closes the last window while the start of its workbench runs, so the title bar step of a start that reaches a closed window
// leaves the native window alone and names no window, with or without a main page.
// contract: application.window.closed-start-sets-no-title-bar
func TestAStartThatReachesAClosedWindowSetsNoTitleBar(t *testing.T) {
	for _, drawn := range []bool{true, false} {
		surfaces, fake := elements(t, &elementWindow{})
		surfaces.elements.drawn = drawn
		mainThreadStep(func() { surfaces.closed = true })
		if err := surfaces.startTitlebar(Record{"textSize": 2.0}); !errors.Is(err, ErrNoStartWindow) {
			t.Fatalf("the start of a closed window (elements drawn %v) ended with %v, want %v", drawn, err, ErrNoStartWindow)
		}
		if len(fake.heights) != 0 || fake.titlebar != 0 {
			t.Fatalf("the start of a closed window (elements drawn %v) set the title bar %v and asked for the page title bar %d times", drawn, fake.heights, fake.titlebar)
		}
	}
}

// contract: surface-layout.element-holds-its-views-until-the-next-frame
func TestAWindowWithAMainPageHasNoElements(t *testing.T) {
	surfaces, _ := elements(t, &elementWindow{})
	surfaces.elements.drawn = false
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
		surfaces, fake := elements(t, &elementWindow{})
		if err := surfaces.startWorkbenchTitlebar(Record{"textSize": 2.0}, shown); err != nil {
			t.Fatal(err)
		}
		if fake.titlebar != 0 {
			t.Fatal("the start asked for the title bar of a main page")
		}
		want := []float64{72}
		if shown {
			want = nil
		}
		if !slices.Equal(fake.heights, want) {
			t.Fatalf("the start of a window that shows a frame %t set the title bar to %v, want %v", shown, fake.heights, want)
		}
		if err := surfaces.startWorkbenchTitlebar(Record{"textSize": "2"}, shown); err == nil ||
			err.Error() != "common setting textSize must be a number, not a string" {
			t.Fatalf("the start of a window that shows a frame %t took the text size \"2\" with %v", shown, err)
		}
	}
}
