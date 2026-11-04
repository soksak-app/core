package host

import (
	"os"
	"testing"

	testplatform "github.com/soksak-app/core/packages/host/go/tests/platform"
)

// TestMain installs the test main-thread function for both functions, because the tests of this package and the sidecars
// that they start run the darwin layer without a framework adapter and a call of a function that is not installed ends the
// process (main_thread.h).
func TestMain(m *testing.M) {
	testplatform.InstallMainThread()
	os.Exit(m.Run())
}
