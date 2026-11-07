//go:build darwin && cgo && diagnostics

package standalone

import (
	"github.com/soksak-app/core/packages/host/go/src/platform/darwin/abi"
	"github.com/soksak-app/core/packages/host/go/tests/platform/darwin/standalone/bindings"
)

// DiagnosticProvider binds the enabled diagnostic profile to the same native library as Provider.
func DiagnosticProvider(callbacks abi.DiagnosticCallbacks) (abi.DiagnosticFunctions, error) {
	if err := bindings.InstallDiagnosticCallbacks(callbacks); err != nil {
		return abi.DiagnosticFunctions{}, err
	}
	return bindings.DiagnosticFunctions(), nil
}
