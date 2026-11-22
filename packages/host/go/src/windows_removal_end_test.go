package host

import (
	"testing"

	"github.com/soksak-app/core/packages/host/go/src/platform"
)

// askedWindow is a window that holds its window events and its close hook, and records the events that it sends to its page and
// each close that the host asks of it.
type askedWindow struct {
	eventWindow
	closing func() bool
	emitted []string
	closes  int
}

func (w *askedWindow) OnClosing(hook func() bool) { w.closing = hook }
func (w *askedWindow) Emit(name string, _ ...any) { w.emitted = append(w.emitted, name) }
func (w *askedWindow) Close()                     { w.closes++ }
func (w *askedWindow) end(event WindowEvent) {
	for _, listener := range w.listeners[event] {
		listener()
	}
}

// askedHost is a host with one ready window whose page can be asked and can end.
func askedHost(t *testing.T) (*Host, *Surfaces, *askedWindow) {
	t.Helper()
	window := &askedWindow{eventWindow: eventWindow{pagelessWindow: pagelessWindow{native: platform.Window(1)}, listeners: map[WindowEvent][]func(){}}}
	previousFramework, previousSystem := framework, system
	framework, system = pagelessFramework{window: window}, &closingPlatform{}
	t.Cleanup(func() { framework, system = previousFramework, previousSystem })
	host := &Host{windows: map[uint]*Surfaces{}, owners: map[string]*Surfaces{}, sidecars: &Sidecars{}, quit: &Quit{}, relay: NewRelay[relayTarget]()}
	s := host.newWindow("main", "")
	host.mu.Lock()
	s.ready = true
	host.mu.Unlock()
	return host, s, window
}

// A removal request ends by the answer of the asked window or by the end of its page (docs/spec/projects.md).
// contract: project-removal.ask.ends-with-the-owner-page
func TestARemovalRequestEndsWithTheEndOfTheOwnerPage(t *testing.T) {
	host, s, window := askedHost(t)
	asked, err := host.removals.Begin("prj-one", s.name)
	if err != nil {
		t.Fatal(err)
	}
	window.end(WindowWorkbenchEnded)
	// A request that waits past the end of the page does not answer, and the check stops at the limit of its runner.
	if allowed := <-asked; !allowed {
		t.Fatal("the end of the asked page refused the removal")
	}
}

// The close of the last window quits the application, also when no quit is in progress, and the close of a window while another one
// stays does not (docs/spec/hosts.md#process-lifecycle).
// contract: log.closed.cause-before-quit
func TestTheCloseOfTheLastWindowQuitsWithoutAQuitInProgress(t *testing.T) {
	host, s, window := askedHost(t)
	second := &Surfaces{name: "second", projects: map[string]string{}}
	host.mu.Lock()
	host.windows[99] = second
	quitWithSecond := host.removeWindowRecords(s, window.ID())
	quitLast := host.removeWindowRecords(second, 99)
	host.mu.Unlock()
	if quitWithSecond {
		t.Fatal("the close of a window quit the application while another window stayed")
	}
	if !quitLast {
		t.Fatal("the close of the last window did not quit the application, which then runs without a window")
	}
}
