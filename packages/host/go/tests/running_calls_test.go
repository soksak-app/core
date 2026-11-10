package host_test

import (
	"testing"
	"time"

	host "github.com/soksak-app/core/packages/host/go/src"
)

// contract: reload.ends-by-ready-close-or-process-end
func TestAReloadThatEndsBeforeReadyNamesTheHostCallsOfItsWindowThatStillRun(t *testing.T) {
	calls := host.NewRunningCalls()
	at := time.Date(2026, 10, 14, 3, 30, 34, 0, time.UTC)
	save := calls.Begin("main", "debug_save_all", at)
	calls.Begin("main", "log", at.Add(94*time.Second))
	other := calls.Begin("project-window-1", "workspace", at)
	now := at.Add(94700 * time.Millisecond)
	if got, want := host.ReloadEndText("the window closed", calls.Of("main", now)), "the window closed before the reloaded page reported ready; running host calls: debug_save_all 94.7s, log 0.7s"; got != want {
		t.Fatalf("text %q, want %q", got, want)
	}
	calls.End(save)
	calls.End(other)
	if got, want := host.ReloadEndText("the page process ended", calls.Of("main", now)), "the page process ended before the reloaded page reported ready; running host calls: log 0.7s"; got != want {
		t.Fatalf("text %q, want %q", got, want)
	}
	if got, want := host.ReloadEndText("the window closed", calls.Of("project-window-1", now)), "the window closed before the reloaded page reported ready; running host calls: none"; got != want {
		t.Fatalf("text %q, want %q", got, want)
	}
}
