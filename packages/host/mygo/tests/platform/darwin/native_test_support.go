//go:build darwin

package darwin

import (
	"sync"

	support "github.com/soksak-app/core/packages/host/go/tests/platform/darwin"
	testabi "github.com/soksak-app/core/packages/host/go/tests/platform/darwin/abi"
	"github.com/soksak-app/core/packages/host/go/tests/platform/darwin/testlibrary"
	"github.com/soksak-app/core/packages/host/mygo/tests/platform/darwin/bindings"
)

var supportOnce sync.Once
var supportError error
var supportFunctions testabi.NativeFunctions

// InstallTestSupport explicitly loads the test artifact and attaches its native
// observer to the same production stall-watch functions used by the mygo host.
func InstallTestSupport() error {
	supportOnce.Do(func() {
		production, err := testlibrary.Open("SOKSAK_NATIVE_LIBRARY")
		if err != nil {
			supportError = err
			return
		}
		library, err := testlibrary.Open("SOKSAK_NATIVE_TEST_LIBRARY")
		if err != nil {
			supportError = err
			return
		}
		functions, err := bindings.Functions(library)
		if err != nil {
			supportError = err
			return
		}
		if supportError = functions.Validate(); supportError != nil {
			return
		}
		counts, err := testlibrary.Symbol(production, "sp_stall_counts")
		if err != nil {
			supportError = err
			return
		}
		setter, err := testlibrary.Symbol(production, "sp_stall_set_send_in_next_wait_for_test")
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
