package adapter

import (
	"errors"
	"fmt"
	"slices"
	"sync"
	"testing"

	"github.com/egoist/mygo/ui"

	host "github.com/soksak-app/core/packages/host/go/src"
	"github.com/soksak-app/core/packages/host/go/src/platform"
)

// startRecord is a workbench that records what the window tells it about its start.
type startRecord struct {
	mu       sync.Mutex
	received []string
}

func (w *startRecord) record(text string) {
	w.mu.Lock()
	defer w.mu.Unlock()
	w.received = append(w.received, text)
}

func (*startRecord) Prepared(*host.Host)                     {}
func (*startRecord) Build(host.Frontend) func(c *ui.Context) { return func(*ui.Context) {} }
func (w *startRecord) Shown(window host.Frontend)            { w.record("shown " + window.Name()) }
func (*startRecord) Close(host.Frontend)                     {}
func (*startRecord) Emit(host.Frontend, string, ...any)      {}
func (*startRecord) Call(host.Frontend, string)              {}
func (w *startRecord) StartFailed(window host.Frontend, err error) {
	w.record("start failed " + window.Name() + ": " + err.Error())
}

// A main page whose start fails gets no start document and does not start, so a workbench whose start the host refuses, as one whose
// window cannot cancel its open layout, is not told that it started (docs/spec/native-host.md#page-start).
// contract: mygo.framework.failed-start-shows-its-failure
func TestAWorkbenchWhoseStartFailsIsNotShown(t *testing.T) {
	// The record of the failure takes its time from the native library, which the first check of the main thread loads.
	system, err := platform.Current()
	if err == nil {
		err = system.RequireMainThread()
	}
	if err != nil {
		t.Fatal(err)
	}
	workbench := &startRecord{}
	framework := NewFramework(workbench)
	cancel := fmt.Errorf("page reload: %w", errors.New("the layout of the window is not cancelled"))
	framework.start = func(*host.Host, host.Frontend, bool) error { return cancel }
	framework.host.Store(&host.Host{})
	window := &Frontend{name: "main", framework: framework}
	window.startHeld()
	want := []string{"start failed main: page reload: the layout of the window is not cancelled"}
	if !slices.Equal(workbench.received, want) {
		t.Fatalf("the workbench received %q, want %q", workbench.received, want)
	}
}

// A quit closes the last window while the start of its workbench runs. The start then names no window, which has no screen to show a
// failure on and no workbench to tell, so the start ends without a failure.
func TestAStartWhoseWindowClosedEndsWithoutAFailure(t *testing.T) {
	workbench := &startRecord{}
	framework := NewFramework(workbench)
	framework.start = func(*host.Host, host.Frontend, bool) error { return fmt.Errorf("workbench start: %w", host.ErrNoStartWindow) }
	framework.host.Store(&host.Host{})
	window := &Frontend{name: "main", framework: framework}
	window.startHeld()
	if len(workbench.received) != 0 {
		t.Fatalf("the workbench of a closed window received %q", workbench.received)
	}
}

// A restarted workbench of a window that went on the screen starts over the last frame of the workbench before it, which the window
// holds until the first screen, so the host keeps the title bar of that frame; a window that has not gone on the screen shows no frame,
// and its title bar takes the row of the settings at once (docs/spec/native-surfaces.md#title-bar-height).
func TestAStartTellsTheHostWhetherTheWindowShowsAFrame(t *testing.T) {
	for _, revealed := range []bool{false, true} {
		framework := NewFramework(&startRecord{})
		var told []bool
		framework.start = func(_ *host.Host, _ host.Frontend, shown bool) error {
			told = append(told, shown)
			return nil
		}
		framework.host.Store(&host.Host{})
		window := &Frontend{name: "main", framework: framework, revealed: revealed}
		window.startHeld()
		if !slices.Equal(told, []bool{revealed}) {
			t.Fatalf("the start of a window that went on the screen %t told the host %v", revealed, told)
		}
	}
}
