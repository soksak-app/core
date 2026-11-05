//go:build diagnostics

package host

import (
	"errors"
	"testing"
	"unsafe"
)

// The surface count of diagnostics.objects is the number of native views of the surfaces of the window, and it falls back when a view is
// removed.
// contract: diagnostics.objects.counts-host-objects
func TestSurfaceCountFollowsTheViewsOfTheWindow(t *testing.T) {
	s := &Surfaces{views: map[string]*nativeWebview{}}
	if got := s.surfaceCount(); got != 0 {
		t.Fatalf("a window without surfaces counts %d surfaces, want 0", got)
	}
	s.views["tab-1"] = &nativeWebview{owner: s}
	s.views["tab-2"] = &nativeWebview{owner: s}
	if got := s.surfaceCount(); got != 2 {
		t.Fatalf("a window with two surfaces counts %d surfaces, want 2", got)
	}
	delete(s.views, "tab-1")
	if got := s.surfaceCount(); got != 1 {
		t.Fatalf("after a surface was removed the window counts %d surfaces, want 1", got)
	}
}

// objectPlatform counts the objects of each page, and a window without a main page has no main web view to count.
type objectPlatform struct {
	pagelessPlatform
}

func (*objectPlatform) MainWebview(unsafe.Pointer) (unsafe.Pointer, error) {
	return nil, errors.New("the window has no registered app DOM webview")
}

func (*objectPlatform) CountPageObjects(_ unsafe.Pointer, _ bool, done func(elements, documents int64, err error)) {
	done(3, 1, nil)
}

// contract: diagnostics.objects.page-is-null-without-a-main-page
func TestAWindowWithoutAMainPageCountsItsHostObjects(t *testing.T) {
	window := &elementWindow{}
	window.native = unsafe.Pointer(new(byte))
	previousFramework, previousSystem := framework, system
	framework, system = pagelessFramework{window: window}, &objectPlatform{}
	t.Cleanup(func() { framework, system = previousFramework, previousSystem })
	sidecars, err := NewSidecars(nil, t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	surfaces := NewSurfaces(window, sidecars)
	surfaces.name = "window-a"
	h := &Host{windows: map[uint]*Surfaces{1: surfaces}, sidecars: sidecars, relay: NewRelay[relayTarget]()}
	h.endpoint = NewEndpoint(hostBackend{h})
	counts, err := hostBackend{h}.ObjectCounts("window-a")
	if err != nil {
		t.Fatal(err)
	}
	if counts.Payload()["page"] != nil || len(counts.Sessions) != 0 {
		t.Fatalf("the counts are %+v", counts.Payload())
	}
}
