//go:build darwin

// Package system_test holds the tests of the Go language host library that hold only on macOS: they use process locks, named
// pipes, sessions, signals, the folders of the system and the main-thread functions of the darwin layer.
package system_test

import (
	"os"
	"runtime"
	"testing"

	testplatform "github.com/soksak-app/core/packages/host/go/tests/platform"
)

// An init function runs on the main thread, and the lock keeps the main goroutine there, so a child that runs the start of the
// host runs it on the main thread as the host does.
func init() { runtime.LockOSThread() }

// TestMain installs the test main-thread function for both functions, because the tests of this package run the darwin layer
// without a framework adapter and a call of a function that is not installed ends the process (main_thread.h).
func TestMain(m *testing.M) {
	testplatform.InstallMainThread()
	if directory := os.Getenv(terminationStart); directory != "" {
		quitAfterTheStart(directory)
		return
	}
	os.Exit(m.Run())
}
