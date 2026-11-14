package host

import (
	"sync/atomic"
	"testing"

	"github.com/soksak-app/core/packages/host/go/src/platform"
)

// markedStepFramework is a framework that runs each step at once and marks the time inside it.
type markedStepFramework struct {
	frameworkRecord
	inside *bool
}

func (f markedStepFramework) Step(task func()) {
	*f.inside = true
	defer func() { *f.inside = false }()
	task()
}

// countedStepFramework runs each step on the main thread and counts the steps.
type countedStepFramework struct {
	mainThreadFramework
	steps *atomic.Int64
}

func (f countedStepFramework) Step(task func()) {
	f.steps.Add(1)
	f.mainThreadFramework.Step(task)
}

// The native observer of the layout ends registers only on the UI thread, and the mygo host opens its session on a worker, where
// a direct registration ended the process with `surface layout requires the UI thread`. The test registers on the native library
// from the goroutine of the test, which is not the main thread, so the registration survives only as a step of the main thread.
// contract: application.window.layout-end-watch-is-a-main-thread-step
func TestTheWatchOfTheLayoutEndsRegistersInAStepOfTheMainThread(t *testing.T) {
	steps := &atomic.Int64{}
	previousFramework := framework
	framework = countedStepFramework{steps: steps}
	t.Cleanup(func() { framework = previousFramework })
	current, err := platform.Current()
	if err != nil {
		t.Fatal(err)
	}
	previousSystem := system
	system = current
	t.Cleanup(func() { system = previousSystem })
	(&Host{}).watchLayoutEnds()
	if got := steps.Load(); got != 1 {
		t.Fatalf("the watch registered in %d steps of the main thread, want 1", got)
	}
}
