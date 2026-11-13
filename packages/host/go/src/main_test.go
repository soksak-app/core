package host

import (
	"os"
	"runtime"
	"testing"

	testplatform "github.com/soksak-app/core/packages/host/go/tests/platform"
)

// An init function runs on the main thread, and the lock keeps the main goroutine there, so the tests of this package that need
// AppKit run on the main thread as the host does (the same pattern as tests/main_test.go).
func init() { runtime.LockOSThread() }

// TestMain installs the test main-thread function for both functions, because the tests of this package and the sidecars
// that they start run the darwin layer without a framework adapter and a call of a function that is not installed ends the
// process (main_thread.h).
func TestMain(m *testing.M) {
	testplatform.InstallMainThread()
	os.Exit(m.Run())
}
