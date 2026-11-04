package host_test

import (
	"os"
	"testing"

	"github.com/soksak-app/core/packages/host/go/src/platform/darwin"
	fixture "github.com/soksak-app/core/packages/host/go/tests/platform/darwin"
)

// TestMain installs the test main-thread function for both functions, because the tests of this package run the darwin layer
// without a framework adapter and a call of a function that is not installed ends the process (main_thread.h).
func TestMain(m *testing.M) {
	run := fixture.TestOnlyRunDirectly()
	darwin.InstallMainThread(run, run)
	os.Exit(m.Run())
}
