//go:build darwin

// Package platform gives the tests of a package what they need of their operating system.
package platform

import (
	"github.com/soksak-app/core/packages/host/go/src/platform/darwin"
	fixture "github.com/soksak-app/core/packages/host/go/tests/platform/darwin"
)

// InstallMainThread installs the test main-thread function for both functions of the darwin layer.
func InstallMainThread() {
	run := fixture.TestOnlyRunDirectly()
	darwin.InstallMainThread(run, run)
}
