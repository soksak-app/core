//go:build darwin && cgo

package staticsupport

/*
#cgo pkg-config: soksak-darwin soksak-host-test
#include "host_test_production_addresses.h"
*/
import "C"

import (
	support "github.com/soksak-app/core/packages/host/go/tests/platform/darwin"
	testabi "github.com/soksak-app/core/packages/host/go/tests/platform/darwin/abi"
	testbindings "github.com/soksak-app/core/packages/host/go/tests/platform/darwin/standalone/testbindings"
	"github.com/soksak-app/core/packages/host/go/tests/platform/darwin/testlibrary"
	"sync"
)

var supportOnce sync.Once
var supportError error
var supportFunctions testabi.NativeFunctions

// InstallTestSupport gives native observers the actual statically linked production stall functions and the production functions
// of the window reads, the event producer and the data store end.
func InstallTestSupport() error {
	supportOnce.Do(func() {
		functions := testbindings.Functions()
		if supportError = functions.Validate(); supportError != nil {
			return
		}
		counts := uintptr(C.sp_host_test_production_stall_counts_address())
		setter := uintptr(C.sp_host_test_production_stall_setter_address())
		if supportError = testlibrary.Error(functions.SpHostTestInstallStallFunctions(counts, setter)); supportError != nil {
			return
		}
		if supportError = testlibrary.Error(functions.SpHostTestInstallProductionFunctions(
			uintptr(C.sp_host_test_production_keys_wait_state_address()), uintptr(C.sp_host_test_production_keys_wait_open_address()),
			uintptr(C.sp_host_test_production_region_raster_address()), uintptr(C.sp_host_test_production_region_present_address()),
			uintptr(C.sp_host_test_production_event_address()), uintptr(C.sp_host_test_production_store_close_address()))); supportError != nil {
			return
		}
		if supportError = support.InstallNativeFunctions(functions); supportError != nil {
			return
		}
		supportFunctions = functions
	})
	return supportError
}

// Functions returns the functions of the statically linked test library after InstallTestSupport installed them.
func Functions() (testabi.NativeFunctions, error) {
	if err := InstallTestSupport(); err != nil {
		return testabi.NativeFunctions{}, err
	}
	return supportFunctions, nil
}

// DirectRunnerAddress returns the native direct runner for standalone test dispatch.
func DirectRunnerAddress() (uintptr, error) {
	if err := InstallTestSupport(); err != nil {
		return 0, err
	}
	return supportFunctions.SpHostTestDirectRunnerAddress(), nil
}
