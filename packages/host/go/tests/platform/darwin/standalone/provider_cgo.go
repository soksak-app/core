//go:build darwin && cgo

package standalone

import (
	"github.com/soksak-app/core/packages/host/go/src/platform/darwin/abi"
	"github.com/soksak-app/core/packages/host/go/tests/platform/darwin/standalone/bindings"
)

// Provider installs the real cgo callback table and returns the static native binding.
func Provider(callbacks abi.Callbacks) (abi.NativeFunctions, error) {
	if err := bindings.InstallCallbacks(callbacks); err != nil {
		return abi.NativeFunctions{}, err
	}
	return bindings.Functions(), nil
}
