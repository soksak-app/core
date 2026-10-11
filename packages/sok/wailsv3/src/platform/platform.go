// Package platform declares the operating system specific behavior of the command line and selects the implementation
// of the current operating system. Each platform/<os>/ package registers its implementation with Register in init, and
// the command imports the packages of all operating systems, so only the implementation of the current operating system
// is registered.
package platform

import (
	"errors"
	"os"
	"time"
)

// Platform is the operating system specific behavior.
type Platform interface {
	// ProcessRunning returns nil when the process pid is running.
	ProcessRunning(pid int) error
	// Key is the release key (`<os>-<arch>`) of this platform; an architecture without a key is an error.
	Key() (string, error)
	// PathsDir is the folder that holds path entries. It is an error when this operating system has no such folder
	// (docs/spec/cli.md).
	PathsDir() (string, error)
	// ExtractBundle extracts the zip of an application bundle into the folder.
	ExtractBundle(zipped, folder string) error
	// BundleVersion is the version that the application bundle at the path declares.
	BundleVersion(bundle string) (string, error)
	// WaitProcessEnd waits until the process pid has ended, and reports false when it still runs after timeout.
	WaitProcessEnd(pid int, timeout time.Duration) (bool, error)
	// CopyBundle copies an application bundle, also across volumes, keeping its modes and signature.
	CopyBundle(source, destination string) error
	// OpenApplication starts a new instance of the application bundle with the arguments.
	OpenApplication(bundle string, arguments []string) error
	// MonotonicNanos is the system-wide monotonic clock in nanoseconds that the events carry as mono_ns
	// (docs/spec/logging.md#event). It is the clock of the native library, so events of different processes compare.
	MonotonicNanos() (uint64, error)
	// LockFile takes an exclusive advisory lock on the open file and waits until it holds it, so the processes that update one
	// index exclude each other (docs/spec/logging.md#index). UnlockFile releases it; closing the file releases it too.
	LockFile(file *os.File) error
	UnlockFile(file *os.File) error
}

var current Platform

// Register registers the implementation of the current operating system.
func Register(platform Platform) { current = platform }

// Current is the registered implementation. It is an error when no implementation exists for this operating system.
func Current() (Platform, error) {
	if current == nil {
		return nil, errors.New("no platform implementation is registered for this operating system")
	}
	return current, nil
}
