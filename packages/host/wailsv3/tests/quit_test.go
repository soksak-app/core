package host_test

import (
	"testing"

	host "github.com/soksak-app/core/packages/host/wailsv3/src"
)

// contract: quit.cancel.ends-the-quit-state
func TestACancelledQuitEndsTheQuitState(t *testing.T) {
	var quit host.Quit
	if quit.Active() {
		t.Fatal("a new quit state is active")
	}
	quit.Begin()
	quit.Begin()
	if !quit.Active() {
		t.Fatal("the quit state is not active after it began")
	}
	quit.Cancel()
	quit.Cancel()
	if quit.Active() {
		t.Fatal("the quit state is active after it was cancelled")
	}
}

// contract: quit.request.begins-the-quit-state
// A quit request begins the quit state before it runs the quit, so a page process end during a quit request that has no ready window
// writes no error line (docs/spec/hosts.md#process-lifecycle).
func TestAQuitRequestWithoutAReadyWindowBeginsTheQuitState(t *testing.T) {
	var quit host.Quit
	requested := false
	quit.Request(func() { requested = true })
	if !requested {
		t.Fatal("the quit request did not run the quit")
	}
	if place, text, reported := host.PageProcessEnded("main", quit.Active()); reported {
		t.Fatalf("the end of a page process during a quit request is written: %s", host.ErrorLine(place, text))
	}
}

// contract: quit.request.begins-the-quit-state
// The operating system quit request begins the quit state when no ready window exists, and it reports that the application quits at once.
func TestAnOperatingSystemQuitWithoutAReadyWindowBeginsTheQuitStateAndQuitsAtOnce(t *testing.T) {
	var quit host.Quit
	if !quit.BeginRequest(0) {
		t.Fatal("a quit request without a ready window does not quit at once")
	}
	if !quit.Active() {
		t.Fatal("a quit request without a ready window does not begin the quit state")
	}
	if place, text, reported := host.PageProcessEnded("main", quit.Active()); reported {
		t.Fatalf("the end of a page process during a quit request is written: %s", host.ErrorLine(place, text))
	}
}
