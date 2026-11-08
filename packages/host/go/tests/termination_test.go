// The cause of a quit is stored before the quit runs.
package host_test

import (
	"testing"
	"time"

	host "github.com/soksak-app/core/packages/host/go/src"
	"github.com/soksak-app/core/packages/host/go/tests/support"
)

// contract: log.closed.cause-before-quit
func TestAQuitStoresItsCauseBeforeItRuns(t *testing.T) {
	log := support.UseEventLog(t)
	var fields any
	host.QuitWithCause("quit-command", func() {
		if err := log.Flush(5 * time.Second); err != nil {
			t.Fatal(err)
		}
		for _, event := range readEventLog(t, log.Path()) {
			if event["event"] == "log.closed" {
				fields = event["fields"]
			}
		}
	})
	if cause, _ := fields.(map[string]any); cause == nil || cause["cause"] != "quit-command" {
		t.Fatalf("log.closed before quit = %v, want the cause quit-command", fields)
	}
}
