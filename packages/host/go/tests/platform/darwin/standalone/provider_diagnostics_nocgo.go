//go:build darwin && !cgo && diagnostics

package standalone

import (
	"github.com/ebitengine/purego"
	"github.com/soksak-app/core/packages/host/go/src/platform/darwin/abi"
	dynamic "github.com/soksak-app/core/packages/host/go/tests/platform/darwin/standalone/dynamic"
	"github.com/soksak-app/core/packages/host/go/tests/platform/darwin/standalone/nativecallback"
	"github.com/soksak-app/core/packages/host/go/tests/platform/darwin/testlibrary"
	"unsafe"
)

func DiagnosticProvider(callbacks abi.DiagnosticCallbacks) (abi.DiagnosticFunctions, error) {
	if err := loadProduction(); err != nil {
		return abi.DiagnosticFunctions{}, err
	}
	functions, err := dynamic.DiagnosticFunctions(productionHandle)
	if err != nil {
		return abi.DiagnosticFunctions{}, err
	}
	if err = functions.Validate(); err != nil {
		return abi.DiagnosticFunctions{}, err
	}
	address, err := testlibrary.Symbol(productionHandle, "sp_host_diagnostic_callbacks_install")
	if err != nil {
		return abi.DiagnosticFunctions{}, err
	}
	var install func(unsafe.Pointer) *byte
	purego.RegisterFunc(&install, address)
	table, err := nativecallback.BindDiagnostic(callbacks)
	if err != nil {
		return abi.DiagnosticFunctions{}, err
	}
	if err = testlibrary.Error(install(unsafe.Pointer(&table[0]))); err != nil {
		return abi.DiagnosticFunctions{}, err
	}
	return functions, nil
}
