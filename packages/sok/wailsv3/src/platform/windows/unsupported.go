//go:build windows

package windows

import (
	"errors"
	"os"
	"time"

	"github.com/soksak-app/core/packages/sok/wailsv3/src/platform"
)

type windows struct{}

func init() { platform.Register(windows{}) }

func (windows) ProcessRunning(int) error {
	return errors.New("process check is not implemented on windows")
}

func (windows) Key() (string, error) {
	return "", errors.New("platform key is not implemented on windows")
}

func (windows) ExtractBundle(string, string) error {
	return errors.New("application bundles are not implemented on windows")
}

func (windows) BundleVersion(string) (string, error) {
	return "", errors.New("application bundles are not implemented on windows")
}

func (windows) WaitProcessEnd(int, time.Duration) (bool, error) {
	return false, errors.New("waiting for a process end is not implemented on windows")
}

func (windows) CopyBundle(string, string) error {
	return errors.New("application bundles are not implemented on windows")
}

func (windows) OpenApplication(string, []string) error {
	return errors.New("application bundles are not implemented on windows")
}

func (windows) MonotonicNanos() (uint64, error) {
	return 0, errors.New("the monotonic clock is not implemented on windows")
}

func (windows) LockFile(*os.File) error {
	return errors.New("file locks are not implemented on windows")
}

func (windows) PathsDir() (string, error) {
	return "", errors.New("path entries are not implemented on windows")
}

func (windows) ApplicationOfBundle(string) (string, bool, error) {
	return "", false, errors.New("application bundles are not implemented on windows")
}

// ApplicationOfIdentifier: the application identifiers of the platform are not implemented on windows.
func (windows) ApplicationOfIdentifier(string) (string, bool, error) {
	return "", false, errors.New("application identifiers are not implemented on windows")
}

// PackageManager: winget is the standard package manager of windows.
func (windows) PackageManager() (string, string) {
	return "windows", "winget"
}
