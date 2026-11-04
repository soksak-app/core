//go:build diagnostics

package host

import "testing"

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
