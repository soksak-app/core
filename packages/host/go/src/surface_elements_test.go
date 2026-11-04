package host

import (
	"errors"
	"slices"
	"testing"
	"unsafe"
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
	held    []unsafe.Pointer
	settled func(float64, error)
}

func (p *elementPlatform) RetainView(view unsafe.Pointer) { p.held = append(p.held, view) }

func (p *elementPlatform) ReleaseView(view unsafe.Pointer) {
	index := slices.Index(p.held, view)
	if index < 0 {
		panic("a view that is not held was released")
	}
	p.held = slices.Delete(p.held, index, index+1)
}

func (p *elementPlatform) AfterSettled(_, _ unsafe.Pointer, done func(float64, error)) error {
	p.settled = done
	return nil
}

// elements returns the surfaces of a window without a main page.
func elements(t *testing.T, window *elementWindow) (*Surfaces, *elementPlatform) {
	t.Helper()
	window.native = unsafe.Pointer(new(byte))
	fake := &elementPlatform{}
	previousFramework, previousSystem := framework, system
	framework, system = pagelessFramework{window: window}, fake
	t.Cleanup(func() { framework, system = previousFramework, previousSystem })
	surfaces := &Surfaces{window: window, invoke: func(task func()) { task() }}
	surfaces.elements.drawn = true
	return surfaces, fake
}

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

func TestAnElementReleasesItsViewsWhenNoFrameCanFollow(t *testing.T) {
	surfaces, fake := elements(t, &elementWindow{failing: true})
	surfaces.setElement("a", SurfaceElement{Surface: unsafe.Pointer(new(byte)), Key: unsafe.Pointer(new(byte))})
	surfaces.setElement("a", SurfaceElement{})
	if len(fake.held) != 0 {
		t.Fatalf("%d views are held after the window closed", len(fake.held))
	}
}

func TestAWindowWithAMainPageHasNoElements(t *testing.T) {
	surfaces, _ := elements(t, &elementWindow{})
	surfaces.elements.drawn = false
	surfaces.setElement("a", SurfaceElement{Surface: unsafe.Pointer(new(byte))})
	if _, ok := surfaces.element("a"); ok {
		t.Fatal("a window with a main page has an element")
	}
}
