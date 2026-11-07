//go:build darwin && diagnostics

package platform

import (
	"github.com/soksak-app/core/packages/host/go/src/platform/darwin"
	fixture "github.com/soksak-app/core/packages/host/go/tests/platform/darwin/standalone"
)

func init() {
	fixture.RegisterStartup(func() error { return darwin.InstallDiagnosticNativeProvider(fixture.DiagnosticProvider) })
}
