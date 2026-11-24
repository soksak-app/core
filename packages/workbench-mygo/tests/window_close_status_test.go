package workbench_test

import (
	"encoding/json"
	"testing"
)

// A close that the host asked for states the step that it waits for and the commands that keep it in core.window.close
// (docs/spec/exposure.md), so a close that does not end is read from the window.
func TestThePendingCloseStatesTheCommandsThatItWaitsFor(t *testing.T) {
	f, stored := updateShell(t, "")
	f.followCalls()
	if got := f.status("core.window.close"); got != `{"commands":[],"step":null}` {
		t.Fatalf("core.window.close before a close request is %s", got)
	}
	hold := newGate()
	stored.holdAppUpdate = hold
	f.shell.Registry().RunLater("core.plugins.registry", json.RawMessage(`{"index":"file:///index.json"}`), func(any, error) {})
	f.settle()
	f.shell.Event("project-close-request", nil)
	f.settle()
	if got := f.status("core.window.close"); got != `{"commands":["core.plugins.registry"],"step":"commands"}` {
		t.Fatalf("core.window.close while a command that started before the close has not answered is %s", got)
	}
	if calls := filterCalls(f.host.calls, "windowClose"); len(calls) != 0 {
		t.Fatalf("the window closed before the command answered: %v", calls)
	}
	hold.open()
	f.settle()
	if calls := filterCalls(f.host.calls, "windowClose"); len(calls) != 1 {
		t.Fatalf("the window close calls after the answer are %v", calls)
	}
	if got := f.status("core.window.close"); got != `{"commands":[],"step":null}` {
		t.Fatalf("core.window.close after the host answered windowClose is %s", got)
	}
}
