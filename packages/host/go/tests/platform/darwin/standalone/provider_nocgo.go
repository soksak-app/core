//go:build darwin && !cgo

package standalone

import (
	"github.com/ebitengine/purego"
	"github.com/soksak-app/core/packages/host/go/src/platform/darwin/abi"
	support "github.com/soksak-app/core/packages/host/go/tests/platform/darwin"
	testabi "github.com/soksak-app/core/packages/host/go/tests/platform/darwin/abi"
	dynamic "github.com/soksak-app/core/packages/host/go/tests/platform/darwin/standalone/dynamic"
	"github.com/soksak-app/core/packages/host/go/tests/platform/darwin/standalone/nativecallback"
	testdynamic "github.com/soksak-app/core/packages/host/go/tests/platform/darwin/standalone/testdynamic"
	"github.com/soksak-app/core/packages/host/go/tests/platform/darwin/testlibrary"
	"sync"
	"unsafe"
)

var productionOnce sync.Once
var productionError error
var productionHandle uintptr
var productionFunctions abi.NativeFunctions

func loadProduction() error {
	productionOnce.Do(func() {
		productionHandle, productionError = testlibrary.Open("SOKSAK_NATIVE_LIBRARY")
		if productionError != nil {
			return
		}
		productionFunctions, productionError = dynamic.Functions(productionHandle)
		if productionError == nil {
			productionError = productionFunctions.Validate()
		}
	})
	return productionError
}

// Provider installs permanent purego callbacks in the explicitly selected production library.
func Provider(callbacks abi.Callbacks) (abi.NativeFunctions, error) {
	if err := loadProduction(); err != nil {
		return abi.NativeFunctions{}, err
	}
	address, err := testlibrary.Symbol(productionHandle, "sp_host_callbacks_install")
	if err != nil {
		return abi.NativeFunctions{}, err
	}
	var install func(unsafe.Pointer) *byte
	purego.RegisterFunc(&install, address)
	table, err := nativecallback.Bind(callbacks)
	if err != nil {
		return abi.NativeFunctions{}, err
	}
	if err = testlibrary.Error(install(unsafe.Pointer(&table[0]))); err != nil {
		return abi.NativeFunctions{}, err
	}
	return productionFunctions, nil
}

var supportOnce sync.Once
var supportError error
var supportFunctions testabi.NativeFunctions

// InstallTestSupport connects the separate test fixture to production's actual stall-watch addresses.
// Both library handles and all callback addresses remain live until process exit.
func InstallTestSupport() error {
	supportOnce.Do(func() {
		if supportError = loadProduction(); supportError != nil {
			return
		}
		library, err := testlibrary.Open("SOKSAK_NATIVE_TEST_LIBRARY")
		if err != nil {
			supportError = err
			return
		}
		functions, err := testdynamic.Functions(library)
		if err != nil {
			supportError = err
			return
		}
		if supportError = functions.Validate(); supportError != nil {
			return
		}
		counts, err := testlibrary.Symbol(productionHandle, "sp_stall_counts")
		if err != nil {
			supportError = err
			return
		}
		setter, err := testlibrary.Symbol(productionHandle, "sp_stall_set_send_in_next_wait_for_test")
		if err != nil {
			supportError = err
			return
		}
		if supportError = testlibrary.Error(functions.SpHostTestInstallStallFunctions(counts, setter)); supportError != nil {
			return
		}
		if supportError = support.InstallNativeFunctions(functions); supportError != nil {
			return
		}
		supportFunctions = functions
	})
	return supportError
}

// testSupport returns the functions of the test library that InstallTestSupport loaded.
func testSupport() (testabi.NativeFunctions, error) {
	if err := InstallTestSupport(); err != nil {
		return testabi.NativeFunctions{}, err
	}
	return supportFunctions, nil
}

func TestOnlyRunDirectly() uintptr {
	if err := InstallTestSupport(); err != nil {
		panic(err)
	}
	return supportFunctions.SpHostTestDirectRunnerAddress()
}

func InstallMainThread(worker, main uintptr) {
	if err := loadProduction(); err != nil {
		panic(err)
	}
	productionFunctions.InstallMainThread(worker, main)
}
