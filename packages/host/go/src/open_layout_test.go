package host

import (
	"errors"
	"testing"

	"github.com/soksak-app/core/packages/host/go/src/platform"
)

// openFrontend is the window of a frame that opens its layout: a layout test window with an id.
type openFrontend struct{ noticeFrontend }

func (*openFrontend) ID() uint { return 1 }

// openPlatform is the platform of a frame that opens its layout: it records the layouts that begin and the cancels.
type openPlatform struct {
	layoutPlatform
	begun []uint64
}

func (p *openPlatform) BeginLayout(_ platform.Window, ticket uint64, _ func(bool)) error {
	p.begun = append(p.begun, ticket)
	return nil
}

// A frame that opened the layout of its window holds the frames of the window until a preparation takes the layout over, so a
// preparation that fails before its layout begins cancels the opened layout, and the frame after it is not held
// (docs/spec/hosts.md#native-views).
// contract: surface-layout.frame-opened-layout-ends-with-a-preparation
func TestAPreparationThatFailsCancelsTheLayoutThatAFrameOpened(t *testing.T) {
	fake := &openPlatform{layoutPlatform: layoutPlatform{commits: make(chan uint64, 1), cancels: make(chan uint64, 2)}}
	saved, savedFramework := system, framework
	system, framework = fake, stepFramework{}
	t.Cleanup(func() { system, framework = saved, savedFramework })
	window := &openFrontend{}
	s := &Surfaces{window: window, images: NewImages(), documents: NewDocuments(), sourceOrigins: newSourceOrigins()}
	h := &Host{windows: map[uint]*Surfaces{1: s}}
	ticket, err := OpenLayout(h, window)
	if err != nil || ticket == 0 || len(fake.begun) != 1 || fake.begun[0] != ticket {
		t.Fatalf("the frame opened the layout %d (%v), and the layouts %v began", ticket, err, fake.begun)
	}
	// A title bar outside its range fails the preparation before its layout begins.
	if _, err := s.SyncSurfaces(SyncRequest{Titlebar: 1}); err == nil {
		t.Fatal("a preparation with an invalid title bar succeeded")
	}
	select {
	case got := <-fake.cancels:
		if got != ticket {
			t.Fatalf("the failed preparation cancelled the layout %d, not the opened %d", got, ticket)
		}
	default:
		t.Fatalf("the failed preparation left the opened layout %d holding the frames of the window", ticket)
	}
	// The opened layout ended with the first preparation, so a later failure cancels nothing.
	if _, err := s.SyncSurfaces(SyncRequest{Titlebar: 1}); err == nil {
		t.Fatal("a preparation with an invalid title bar succeeded")
	}
	select {
	case got := <-fake.cancels:
		t.Fatalf("a second failed preparation cancelled the layout %d", got)
	default:
	}
}

// The close of a window cancels the layouts that it began, and its workbench commits none after the close, so a preparation that
// reaches the main thread after the close begins no layout: that layout would stay open and hold the layouts and the frames of every
// other window (docs/spec/hosts.md#native-views).
// contract: surface-layout.closed-window-begins-no-layout
func TestAPreparationOfAClosedWindowBeginsNoLayout(t *testing.T) {
	fake := &openPlatform{layoutPlatform: layoutPlatform{commits: make(chan uint64, 1), cancels: make(chan uint64, 2)}}
	saved, savedFramework := system, framework
	window := &openFrontend{}
	// A mygo window has no main page, so its preparation places no window overlays.
	system, framework = fake, pagelessFramework{window: window}
	t.Cleanup(func() { system, framework = saved, savedFramework })
	s := &Surfaces{window: window, images: NewImages(), documents: NewDocuments(), sourceOrigins: newSourceOrigins(), closed: true}
	// The page of the window was ready before the close.
	s.first.Do(func() {})
	if _, err := s.SyncSurfaces(SyncRequest{Titlebar: 40}); !errors.Is(err, errWindowClosed) {
		t.Fatalf("the preparation of a closed window ended with %v, not that the window closed", err)
	}
	if len(fake.begun) != 0 {
		t.Fatalf("the preparation of a closed window began the layouts %v", fake.begun)
	}
}
