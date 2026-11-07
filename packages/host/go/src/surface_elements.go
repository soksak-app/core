package host

import (
	"sync"
	"unsafe"
)

// SurfaceElement names the views of a surface to the workbench of a window without a main page, which shows the surface through a
// native view element (docs/spec/hosts.md#native-views).
type SurfaceElement struct {
	// Surface is the surface host and Key the web view of the view page, which takes the keyboard.
	Surface, Key unsafe.Pointer
}

// surfaceElements holds the elements of the surfaces of a window. A frame reads them while it draws, on the thread of its frames, and
// places them later on the main thread, where a surface can close in between. So the element holds its views: a surface that leaves
// the list keeps them until the next settled frame, which started after it left.
type surfaceElements struct {
	// drawn is decided when the window is created: a window without a main page draws its surfaces as elements.
	drawn bool
	mu    sync.Mutex
	by    map[string]SurfaceElement
}

// DetachingSurfaces returns the surfaces of window whose image detach is pending, which a workbench without a page reads in place of
// pendingSurfaces of the start document. It is a function and not a method of Host, because each exported method of Host is a host
// call of a page.
func DetachingSurfaces(h *Host, window Frontend) []string {
	h.mu.Lock()
	s := h.windows[window.ID()]
	h.mu.Unlock()
	if s == nil {
		return nil
	}
	return s.pendingImageDetachSurfaces()
}

// ElementOf returns the element of the surface id of window. A frame calls it, so it takes no step of the main thread. It is no method
// of Host, because each exported method of Host is a host call of a page.
func ElementOf(h *Host, window Frontend, id string) (SurfaceElement, bool) {
	h.mu.Lock()
	s := h.windows[window.ID()]
	h.mu.Unlock()
	if s == nil {
		return SurfaceElement{}, false
	}
	return s.element(id)
}

// ElementSurface returns the surface host of the element of window whose surface host is view, which a framework names by the
// integer of its address. The host received the surface host from native code, and the framework gives back only its integer, so
// the pointer comes from the element and not from the integer. It is no method of Host, because each exported method of Host is a
// host call of a page.
func ElementSurface(h *Host, window Frontend, view uintptr) (unsafe.Pointer, bool) {
	h.mu.Lock()
	s := h.windows[window.ID()]
	h.mu.Unlock()
	if s == nil {
		return nil, false
	}
	s.elements.mu.Lock()
	defer s.elements.mu.Unlock()
	for _, element := range s.elements.by {
		if uintptr(element.Surface) == view {
			return element.Surface, true
		}
	}
	return nil, false
}

func (s *Surfaces) element(id string) (SurfaceElement, bool) {
	s.elements.mu.Lock()
	defer s.elements.mu.Unlock()
	element, ok := s.elements.by[id]
	return element, ok
}

// swap makes next the element of the surface id, or removes the element when next is empty, and returns the element it replaced.
func (e *surfaceElements) swap(id string, next SurfaceElement) SurfaceElement {
	e.mu.Lock()
	defer e.mu.Unlock()
	if e.by == nil {
		e.by = map[string]SurfaceElement{}
	}
	last := e.by[id]
	if next == (SurfaceElement{}) {
		delete(e.by, id)
	} else {
		e.by[id] = next
	}
	return last
}

// setElement makes next the element of the surface id, in a window that draws its surfaces as elements. Call it before the views of
// the replaced element close.
func (s *Surfaces) setElement(id string, next SurfaceElement) {
	if s.elements.drawn {
		s.invoke(func() { s.publishElement(id, next) })
	}
}

// publishElement runs setElement on the main thread.
func (s *Surfaces) publishElement(id string, next SurfaceElement) {
	for _, view := range []unsafe.Pointer{next.Surface, next.Key} {
		if view != nil {
			system.RetainView(view)
		}
	}
	last := s.elements.swap(id, next)
	if last == (SurfaceElement{}) {
		return
	}
	release := func() {
		for _, view := range []unsafe.Pointer{last.Surface, last.Key} {
			if view != nil {
				system.ReleaseView(view)
			}
		}
	}
	if err := s.afterNextFrame(release); err != nil {
		LogError("surface element", err)
		release()
	}
}

// afterNextFrame runs done on the main thread after the window presented a frame that started after this call, or once the window
// can present none. Call it on the main thread.
func (s *Surfaces) afterNextFrame(done func()) error {
	present, err := s.window.SettledPresentation()
	if err != nil {
		return err
	}
	return system.AfterSettled(s.window.NativeWindow(), present, func(float64, error) { done() })
}
