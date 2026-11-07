//go:build darwin

package darwin

import (
	"fmt"
	"sync"

	testabi "github.com/soksak-app/core/packages/host/go/tests/platform/darwin/abi"
)

var nativeFunctionsMu sync.Mutex
var nativeFunctions testabi.NativeFunctions
var nativeFunctionsInstalled bool

// InstallNativeFunctions publishes one complete native test interface before
// sampling. Its owner keeps the native library and function addresses alive.
func InstallNativeFunctions(functions testabi.NativeFunctions) error {
	nativeFunctionsMu.Lock()
	defer nativeFunctionsMu.Unlock()
	if nativeFunctionsInstalled {
		return fmt.Errorf("native test functions are already installed")
	}
	if err := functions.Validate(); err != nil {
		return err
	}
	nativeFunctions = functions
	nativeFunctionsInstalled = true
	return nil
}

func installedNativeFunctions() (testabi.NativeFunctions, error) {
	nativeFunctionsMu.Lock()
	defer nativeFunctionsMu.Unlock()
	if !nativeFunctionsInstalled {
		return testabi.NativeFunctions{}, fmt.Errorf("native test functions are not installed")
	}
	return nativeFunctions, nil
}

func requireNativeFunctions() testabi.NativeFunctions {
	functions, err := installedNativeFunctions()
	if err != nil {
		panic(err)
	}
	return functions
}
