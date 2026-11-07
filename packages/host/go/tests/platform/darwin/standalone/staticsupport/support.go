//go:build darwin && cgo

package staticsupport

/*
#cgo pkg-config: soksak-darwin soksak-host-test
#include "host_test_stall_addresses.h"
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

// InstallTestSupport gives native observers the actual statically linked production stall functions.
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
		if supportError = support.InstallNativeFunctions(functions); supportError != nil {
			return
		}
		supportFunctions = functions
	})
	return supportError
}

// DirectRunnerAddress returns the native direct runner for standalone test dispatch.
func DirectRunnerAddress() (uintptr, error) {
	if err := InstallTestSupport(); err != nil {
		return 0, err
	}
	return supportFunctions.SpHostTestDirectRunnerAddress(), nil
}
