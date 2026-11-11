package host

import (
	"testing"

	"github.com/soksak-app/core/packages/host/go/src/platform"
)

// markedStepFramework is the framework of the test of the layout end watch: it runs each step at once and marks the time
// inside it.
type markedStepFramework struct {
	frameworkRecord
	inside *bool
}

func (f markedStepFramework) Step(task func()) {
	*f.inside = true
	defer func() { *f.inside = false }()
	task()
}

// layoutWatchPlatform records whether its watch of the layout ends was registered inside a step of the main thread.
type layoutWatchPlatform struct {
	platform.Platform
	inside            *bool
	registered, outer int
}

func (p *layoutWatchPlatform) WatchLayoutEnds(func(platform.Window)) error {
	if *p.inside {
		p.registered++
	} else {
		p.outer++
	}
	return nil
}

// The native observer of the layout ends registers only on the UI thread, and the mygo host opens its session on a worker, where
// a direct registration ended the process with `surface layout requires the UI thread`.
// contract: application.window.layout-end-watch-is-a-main-thread-step
func TestTheWatchOfTheLayoutEndsRegistersInAStepOfTheMainThread(t *testing.T) {
	inside := false
	previousFramework := framework
	framework = markedStepFramework{inside: &inside}
	t.Cleanup(func() { framework = previousFramework })
	fake := &layoutWatchPlatform{inside: &inside}
	previousSystem := system
	system = fake
	t.Cleanup(func() { system = previousSystem })
	(&Host{}).watchLayoutEnds()
	if fake.registered != 1 || fake.outer != 0 {
		t.Fatalf("the watch registered %d times inside a step and %d times outside, want once inside", fake.registered, fake.outer)
	}
}
