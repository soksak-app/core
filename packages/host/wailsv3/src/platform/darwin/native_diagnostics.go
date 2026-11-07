//go:build darwin && diagnostics

package darwin

import (
	common "github.com/soksak-app/core/packages/host/go/src/platform/darwin"
	"github.com/soksak-app/core/packages/host/go/src/platform/darwin/abi"
	"github.com/soksak-app/core/packages/host/wailsv3/src/platform/darwin/bindings"
)

func init() {
	if err := common.InstallDiagnosticNativeProvider(func(callbacks abi.DiagnosticCallbacks) (abi.DiagnosticFunctions, error) {
		functions := bindings.DiagnosticFunctions()
		if err := functions.Validate(); err != nil {
			return abi.DiagnosticFunctions{}, err
		}
		if err := bindings.InstallDiagnosticCallbacks(callbacks); err != nil {
			return abi.DiagnosticFunctions{}, err
		}
		return functions, nil
	}); err != nil {
		panic(err)
	}
}
