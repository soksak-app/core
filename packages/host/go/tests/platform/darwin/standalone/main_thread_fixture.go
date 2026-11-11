//go:build darwin && cgo

package standalone

import (
	testabi "github.com/soksak-app/core/packages/host/go/tests/platform/darwin/abi"
	productionBindings "github.com/soksak-app/core/packages/host/go/tests/platform/darwin/standalone/bindings"
	"github.com/soksak-app/core/packages/host/go/tests/platform/darwin/standalone/staticsupport"
)

// InstallTestSupport connects the leaf sampler fixture to static production state.
func InstallTestSupport() error { return staticsupport.InstallTestSupport() }

// testSupport returns the functions of the statically linked test library that InstallTestSupport installed.
func testSupport() (testabi.NativeFunctions, error) { return staticsupport.Functions() }

// TestOnlyRunDirectly supplies the canonical native runner to standalone tests only.
func TestOnlyRunDirectly() uintptr {
	address, err := staticsupport.DirectRunnerAddress()
	if err != nil {
		panic(err)
	}
	return address
}

// InstallMainThread changes actual production dispatch state for standalone tests.
func InstallMainThread(worker, main uintptr) {
	productionBindings.Functions().InstallMainThread(worker, main)
}
