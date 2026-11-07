//go:build darwin

package darwin

import (
	"os"
	"testing"

	fixture "github.com/soksak-app/core/packages/host/go/tests/platform/darwin"
)

// TestMain installs the test main-thread function for both functions, because the tests of this package run the darwin layer
// without a framework adapter and a call of a function that is not installed ends the process (main_thread.h).
func TestMain(m *testing.M) {
	if os.Getenv(earlyShowChild) != "" {
		// Early-show tests must observe startup before any provider is initialized.
		os.Exit(m.Run())
	}
	if err := fixture.InstallProviders(InstallNativeProvider); err != nil {
		panic(err)
	}
	run := fixture.TestOnlyRunDirectly()
	fixture.InstallMainThread(run, run)
	if err := (implementation{}).RequireMainThread(); err != nil {
		panic(err)
	}
	os.Exit(m.Run())
}
