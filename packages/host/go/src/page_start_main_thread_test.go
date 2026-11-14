package host

import (
	"testing"

	"github.com/soksak-app/core/packages/host/go/src/platform"
	support "github.com/soksak-app/core/packages/host/go/tests/platform/darwin"
)

// markedMainThreadFramework is a framework whose steps run on the main thread of the native library and mark the time inside them.
type markedMainThreadFramework struct {
	frameworkRecord
	inside *bool
}

func (f markedMainThreadFramework) Step(task func()) {
	stepOnMainThread(func() {
		*f.inside = true
		defer func() { *f.inside = false }()
		task()
	})
}

// pageStartCalls is the platform of the operating system, which records whether each native call of the start of a page ran inside a
// step of the main thread. Every call goes on to the platform of the operating system, and the window is a window of that platform.
type pageStartCalls struct {
	platform.Platform
	inside       *bool
	inner, outer []string
}

func (p *pageStartCalls) record(name string) {
	if *p.inside {
		p.inner = append(p.inner, name)
	} else {
		p.outer = append(p.outer, name)
	}
}

func (p *pageStartCalls) WindowControls(window platform.Window) (platform.Rect, error) {
	p.record("WindowControls")
	return p.Platform.WindowControls(window)
}

func (p *pageStartCalls) TitlebarHeight(window platform.Window) (float64, error) {
	p.record("TitlebarHeight")
	return p.Platform.TitlebarHeight(window)
}

func (p *pageStartCalls) SetTitlebarHeight(window platform.Window, height float64) error {
	p.record("SetTitlebarHeight")
	return p.Platform.SetTitlebarHeight(window, height)
}

func (p *pageStartCalls) StartPageTitlebar(window platform.Window, ticket uint64, height float64, ready func(error)) error {
	p.record("StartPageTitlebar")
	return p.Platform.StartPageTitlebar(window, ticket, height, ready)
}

// The start document of a page is served on a goroutine of the asset server, and the window reads and changes that it makes call
// AppKit, which a thread other than the main thread may not call; the Rust host had such a call end the process (F738).
// contract: page.start.native-calls-are-main-thread-steps
func TestTheStartOfAPageCallsTheWindowOnlyInStepsOfTheMainThread(t *testing.T) {
	current, err := platform.Current()
	if err != nil {
		t.Fatal(err)
	}
	native := support.TitledWindowWithMainPage(t, runOnMainThread, 500, 400, "main-page.html")
	inside := false
	previousFramework := framework
	framework = markedMainThreadFramework{inside: &inside}
	t.Cleanup(func() { framework = previousFramework })
	calls := &pageStartCalls{Platform: current, inside: &inside}
	previousSystem := system
	system = calls
	t.Cleanup(func() { system = previousSystem })
	for _, drawn := range []bool{false, true} {
		s := &Surfaces{window: &pagelessWindow{native: native}}
		s.elements.drawn = drawn
		if err := s.startTitlebar(Record{}); err != nil {
			t.Fatalf("title bar of the start (drawn %v): %v", drawn, err)
		}
		if _, err := s.WindowChrome(); err != nil {
			t.Fatalf("window chrome of the start (drawn %v): %v", drawn, err)
		}
	}
	if len(calls.outer) != 0 || len(calls.inner) != 6 {
		t.Fatalf("native calls inside a step %v, outside %v; want every call inside", calls.inner, calls.outer)
	}
}
