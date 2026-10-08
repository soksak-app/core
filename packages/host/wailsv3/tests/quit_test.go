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
