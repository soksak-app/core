// A failure of a startup step ends the process with its message and the status 1 (docs/spec/hosts.md#process-lifecycle); the Tauri
// host returns no failure of its setup steps to the event loop, which would abort the process.
package host_test

import (
	"errors"
	"testing"

	host "github.com/soksak-app/core/packages/host/wailsv3/src"
)

// contract: startup.failure.exits-with-its-message
func TestAFailedStartupStepWritesItsMessageAndExitsWithStatusOne(t *testing.T) {
	var written []string
	var statuses []int
	host.ExitOnFailureWith(errors.New("installed plugins: plugins/installed.json browser: unknown field package"),
		func(text string) { written = append(written, text) }, func(status int) { statuses = append(statuses, status) })
	if len(written) != 1 || written[0] != "installed plugins: plugins/installed.json browser: unknown field package" {
		t.Fatalf("written = %q", written)
	}
	if len(statuses) != 1 || statuses[0] != 1 {
		t.Fatalf("exit statuses = %v, want [1]", statuses)
	}
}

// contract: startup.failure.exits-with-its-message
func TestAStartupStepThatSucceedsWritesNothingAndDoesNotExit(t *testing.T) {
	called := false
	host.ExitOnFailureWith(nil, func(string) { called = true }, func(int) { called = true })
	if called {
		t.Fatal("a successful step wrote or exited")
	}
}
