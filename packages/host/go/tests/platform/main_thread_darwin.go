//go:build darwin

// Package platform gives the tests of a package what they need of their operating system.
package platform

import (
	"github.com/soksak-app/core/packages/host/go/src/platform"
	"github.com/soksak-app/core/packages/host/go/src/platform/darwin"
	fixture "github.com/soksak-app/core/packages/host/go/tests/platform/darwin"
)

// InstallMainThread installs the test main-thread function for both functions of the darwin layer.
func InstallMainThread() {
	if err := fixture.InstallProviders(darwin.InstallNativeProvider); err != nil {
		panic(err)
	}
	run := fixture.TestOnlyRunDirectly()
	fixture.InstallMainThread(run, run)
	system, err := platform.Current()
	if err != nil {
		panic(err)
	}
	if err := system.RequireMainThread(); err != nil {
		panic(err)
	}
}
