package host_test

import (
	"os"
	"runtime"
	"testing"

	"github.com/soksak-app/core/packages/host/go/src/platform/darwin"
	fixture "github.com/soksak-app/core/packages/host/go/tests/platform/darwin"
)

// An init function runs on the main thread, and the lock keeps the main goroutine there, so a child that runs the start of the
// host runs it on the main thread as the host does.
func init() { runtime.LockOSThread() }

// TestMain installs the test main-thread function for both functions, because the tests of this package run the darwin layer
// without a framework adapter and a call of a function that is not installed ends the process (main_thread.h).
func TestMain(m *testing.M) {
	run := fixture.TestOnlyRunDirectly()
	darwin.InstallMainThread(run, run)
	if directory := os.Getenv(terminationStart); directory != "" {
		quitAfterTheStart(directory)
		return
	}
	os.Exit(m.Run())
}
