//go:build darwin && diagnostics

package darwin

import fixture "github.com/soksak-app/core/packages/host/go/tests/platform/darwin"

func init() {
	fixture.RegisterStartup(func() error { return InstallDiagnosticNativeProvider(fixture.DiagnosticProvider) })
}
