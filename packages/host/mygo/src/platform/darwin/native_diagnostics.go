//go:build darwin && diagnostics

package darwin

import (
	"unsafe"

	"github.com/ebitengine/purego"
	common "github.com/soksak-app/core/packages/host/go/src/platform/darwin"
	"github.com/soksak-app/core/packages/host/go/src/platform/darwin/abi"
	"github.com/soksak-app/core/packages/host/mygo/src/platform/darwin/bindings"
	"github.com/soksak-app/core/packages/host/mygo/src/platform/darwin/nativecallback"
)

func init() {
	if err := common.InstallDiagnosticNativeProvider(func(callbacks abi.DiagnosticCallbacks) (abi.DiagnosticFunctions, error) {
		library, err := nativeLibrary()
		if err != nil {
			return abi.DiagnosticFunctions{}, err
		}
		functions, err := bindings.DiagnosticFunctions(library)
		if err != nil {
			return abi.DiagnosticFunctions{}, err
		}
		if err = functions.Validate(); err != nil {
			return abi.DiagnosticFunctions{}, err
		}
		address, err := requiredSymbol(library, "sp_host_diagnostic_callbacks_install")
		if err != nil {
			return abi.DiagnosticFunctions{}, err
		}
		var install func(unsafe.Pointer) *byte
		purego.RegisterFunc(&install, address)
		table, err := nativecallback.BindDiagnostic(callbacks)
		if err != nil {
			return abi.DiagnosticFunctions{}, err
		}
		if err = callbackInstallError(install(unsafe.Pointer(&table[0]))); err != nil {
			return abi.DiagnosticFunctions{}, err
		}
		return functions, nil
	}); err != nil {
		panic(err)
	}
}
