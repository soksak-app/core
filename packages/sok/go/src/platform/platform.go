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
	// ServiceProcessExists checks whether pid is the live sidecar service process that published the endpoint whose modification
	// time is published: a process that started later received the pid after the publisher ended
	// (docs/spec/persistent-services.md#endpoint-publisher). The hosts read it before they reuse an endpoint, and the installer
	// before it changes the version of a sidecar (docs/spec/persistent-services.md#updates). It is an error when this cannot be
	// determined.
	ServiceProcessExists(pid int, published time.Time) (bool, error)
	// Key is the release key (`<os>-<arch>`) of this platform; an architecture without a key is an error.
	Key() (string, error)
	// UserPath is nil when this operating system has the user PATH registration, and otherwise the reason that it has none
	// (docs/spec/cli.md#user-path-registration).
	UserPath() error
	// ExtractBundle extracts the zip of an application bundle into the folder.
	ExtractBundle(zipped, folder string) error
	// BundleVersion is the version that the application bundle at the path declares.
	BundleVersion(bundle string) (string, error)
	// WaitProcessEnd waits until the operating system reports that the process pid ended. It takes no time limit.
	WaitProcessEnd(pid int) error
	// CopyBundle copies an application bundle, also across volumes, keeping its modes and signature.
	CopyBundle(source, destination string) error
	// OpenApplication starts a new instance of the application bundle with the arguments. It activates the new instance
	// only when activate is set.
	OpenApplication(bundle string, arguments []string, activate bool) error
	// MonotonicNanos is the system-wide monotonic clock in nanoseconds that the events carry as mono_ns
	// (docs/spec/logging.md#event). It is the clock of the native library, so events of different processes compare.
	MonotonicNanos() (uint64, error)
	// LockFile takes an exclusive advisory lock on the open file and waits until it holds it, so the processes that update one
	// index exclude each other (docs/spec/logging.md#index). Closing the file releases the lock.
	LockFile(file *os.File) error
	// TryLockFile takes an exclusive advisory lock (flock LOCK_EX|LOCK_NB) on the open file without waiting. It reports false when
	// another open file holds the lock, which is the ownership of the configuration directory (docs/spec/endpoint.md#discovery).
	TryLockFile(file *os.File) (bool, error)
	// PrepareLogDirectory creates the missing event-log directories with private access and restricts the final directory to mode 0700.
	PrepareLogDirectory(path string) error
	// CreateLogFile creates a new event-log file for appending with private access (mode 0600 on Unix).
	CreateLogFile(path string) (*os.File, error)
	// AppendLogFile opens an event-log file for appending, creating it with private access when absent.
	AppendLogFile(path string) (*os.File, error)
	// OpenProcessLockFile opens or creates the configuration ownership lock with private access (mode 0600 on Unix).
	OpenProcessLockFile(path string) (*os.File, error)
	// OpenAgentSetupLockFile opens or creates the user setup lock with mode 0600 and refuses symbolic links.
	OpenAgentSetupLockFile(path string) (*os.File, error)
	// ReadOnlyVolume reports whether the file system of the path is mounted read-only (docs/spec/cli.md#mcp-registration).
	ReadOnlyVolume(path string) (bool, error)
	// RegisteredSok checks that the sok that the MCP registration names belongs to an application of this platform: on macOS it is
	// in Contents/MacOS of a folder whose name ends in .app (docs/spec/cli.md#mcp-registration).
	RegisteredSok(path string) error
	// ReplaceProcess replaces the running process with the executable at path, with the arguments and the environment
	// (docs/spec/cli.md#the-window-of-an-agent). It returns only when the replacement fails.
	ReplaceProcess(path string, args, env []string) error
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
