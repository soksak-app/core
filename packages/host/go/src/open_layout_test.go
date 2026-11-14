package host

import (
	"errors"
	"testing"

	"github.com/soksak-app/core/packages/host/go/src/platform"
	support "github.com/soksak-app/core/packages/host/go/tests/platform/darwin"
)

// openFrontend is the window of a frame that opens its layout: a layout test window with an id and the native window of the platform.
type openFrontend struct {
	noticeFrontend
	native platform.Window
}

func (*openFrontend) ID() uint                        { return 1 }
func (f *openFrontend) NativeWindow() platform.Window { return f.native }

// A frame that opened the layout of its window holds the frames of the window until a preparation takes the layout over, so a
// preparation that fails before its layout begins cancels the opened layout, and the frame after it is not held
// (docs/spec/hosts.md#native-views). The window and its layouts are of the real platform: the native layer takes the commit of the ticket
// of an open layout and refuses the commit of a ticket whose layout was cancelled.
// contract: surface-layout.frame-opened-layout-ends-with-a-preparation
func TestAPreparationThatFailsCancelsTheLayoutThatAFrameOpened(t *testing.T) {
	useCurrentPlatformForViews(t)
	savedFramework := framework
	framework = mainThreadFramework{}
	t.Cleanup(func() { framework = savedFramework })
	native := support.WindowWithMainPage(t, runOnMainThread, 400, 300, "main-page.html")
	t.Cleanup(func() { runOnMainThread(func() { system.CancelLayout(native) }) })
	window := &openFrontend{native: native}
	s := &Surfaces{window: window, images: NewImages(), documents: NewDocuments(), sourceOrigins: newSourceOrigins()}
	h := &Host{windows: map[uint]*Surfaces{1: s}}
	var ticket uint64
	var err error
	runOnMainThread(func() { ticket, err = OpenLayout(h, window) })
	if err != nil || ticket == 0 {
		t.Fatalf("the frame opened the layout %d (%v)", ticket, err)
	}
	// A title bar outside its range fails the preparation before its layout begins.
	if _, err := s.SyncSurfaces(SyncRequest{Titlebar: 1}); err == nil {
		t.Fatal("a preparation with an invalid title bar succeeded")
	}
	if commitLayout(native, ticket) {
		t.Fatalf("the failed preparation left the opened layout %d holding the frames of the window", ticket)
	}
	// The opened layout ended with the first preparation, so a later failure cancels nothing: the layout that a frame opens after it
	// stays open.
	var later uint64
	runOnMainThread(func() { later, err = OpenLayout(h, window) })
	if err != nil || later == 0 {
		t.Fatalf("the frame opened the layout %d (%v) after the failed preparation", later, err)
	}
	if _, err := s.SyncSurfaces(SyncRequest{Titlebar: 1}); err == nil {
		t.Fatal("a preparation with an invalid title bar succeeded")
	}
	if commitLayout(native, later) {
		t.Fatalf("the second failed preparation left the layout %d open", later)
	}
}

// The close of a window cancels the layouts that it began, and its workbench commits none after the close, so a preparation that
// reaches the main thread after the close begins no layout: that layout would stay open and hold the layouts and the frames of every
// other window (docs/spec/hosts.md#native-views).
// contract: surface-layout.closed-window-begins-no-layout
func TestAPreparationOfAClosedWindowBeginsNoLayout(t *testing.T) {
	useCurrentPlatformForViews(t)
	native := support.WindowWithMainPage(t, runOnMainThread, 400, 300, "main-page.html")
	t.Cleanup(func() { runOnMainThread(func() { system.CancelLayout(native) }) })
	window := &openFrontend{native: native}
	savedFramework := framework
	// A mygo window has no main page, so its preparation places no window overlays.
	framework = pagelessFramework{window: window}
	t.Cleanup(func() { framework = savedFramework })
	s := &Surfaces{window: window, images: NewImages(), documents: NewDocuments(), sourceOrigins: newSourceOrigins(), closed: true}
	// The page of the window was ready before the close.
	s.first.Do(func() {})
	var err error
	runOnMainThread(func() { _, err = s.SyncSurfaces(SyncRequest{Titlebar: 40}) })
	if !errors.Is(err, errWindowClosed) {
		t.Fatalf("the preparation of a closed window ended with %v, not that the window closed", err)
	}
	// A preparation that began a layout would have opened the transaction of ticket 1, whose commit the native layer takes.
	if commitLayout(native, 1) {
		t.Fatal("the preparation of a closed window began a layout")
	}
}
