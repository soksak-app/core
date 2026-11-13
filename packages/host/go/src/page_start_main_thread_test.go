package host

import (
	"testing"

	"github.com/soksak-app/core/packages/host/go/src/platform"
)

// pageStartPlatform records whether each native call of the start of a page ran inside a step of the main thread.
type pageStartPlatform struct {
	platform.Platform
	inside       *bool
	inner, outer []string
}

func (p *pageStartPlatform) record(name string) {
	if *p.inside {
		p.inner = append(p.inner, name)
	} else {
		p.outer = append(p.outer, name)
	}
}

func (p *pageStartPlatform) WindowControls(platform.Window) (platform.Rect, error) {
	p.record("WindowControls")
	return platform.Rect{}, nil
}

func (p *pageStartPlatform) TitlebarHeight(platform.Window) (float64, error) {
	p.record("TitlebarHeight")
	return 40, nil
}

func (p *pageStartPlatform) SetTitlebarHeight(platform.Window, float64) error {
	p.record("SetTitlebarHeight")
	return nil
}

func (p *pageStartPlatform) StartPageTitlebar(_ platform.Window, _ uint64, _ float64, ready func(error)) error {
	p.record("StartPageTitlebar")
	ready(nil)
	return nil
}

// The start document of a page is served on a goroutine of the asset server, and the window reads and changes that it makes call
// AppKit, which a thread other than the main thread may not call; the Rust host had such a call end the process (F738).
// contract: page.start.native-calls-are-main-thread-steps
func TestTheStartOfAPageCallsTheWindowOnlyInStepsOfTheMainThread(t *testing.T) {
	inside := false
	previousFramework := framework
	framework = markedStepFramework{inside: &inside}
	t.Cleanup(func() { framework = previousFramework })
	fake := &pageStartPlatform{inside: &inside}
	previousSystem := system
	system = fake
	t.Cleanup(func() { system = previousSystem })
	for _, drawn := range []bool{false, true} {
		s := &Surfaces{window: &noticeFrontend{}}
		s.elements.drawn = drawn
		if err := s.startTitlebar(Record{}); err != nil {
			t.Fatalf("title bar of the start (drawn %v): %v", drawn, err)
		}
		if _, err := s.WindowChrome(); err != nil {
			t.Fatalf("window chrome of the start (drawn %v): %v", drawn, err)
		}
	}
	if len(fake.outer) != 0 || len(fake.inner) != 6 {
		t.Fatalf("native calls inside a step %v, outside %v; want every call inside", fake.inner, fake.outer)
	}
}
