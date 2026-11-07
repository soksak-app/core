//go:build darwin

package darwin

import (
	"fmt"
	"github.com/soksak-app/core/packages/host/go/src/platform/darwin/abi"
	"sync"
)

var native abi.NativeFunctions
var nativeProvider func(abi.Callbacks) (abi.NativeFunctions, error)
var nativeProviderMu sync.Mutex
var nativeStarted bool
var nativeOnce sync.Once
var nativeError error
var nativeProfiles []func() error

// InstallNativeProvider declares the framework-owned native binding before host startup.
// The provider runs once, when the host first requires its native interface.
func InstallNativeProvider(provider func(abi.Callbacks) (abi.NativeFunctions, error)) error {
	nativeProviderMu.Lock()
	defer nativeProviderMu.Unlock()
	if provider == nil {
		return fmt.Errorf("native provider is nil")
	}
	if nativeProvider != nil || nativeStarted {
		return fmt.Errorf("native provider is already installed or startup has begun")
	}
	nativeProvider = provider
	return nil
}

func ensureNative() error {
	nativeOnce.Do(func() {
		nativeProviderMu.Lock()
		nativeStarted = true
		provider := nativeProvider
		nativeProviderMu.Unlock()
		if provider == nil {
			nativeError = fmt.Errorf("framework adapter has not installed its native provider")
			return
		}
		functions, err := provider(callbackHandlers())
		if err != nil {
			nativeError = err
			return
		}
		if err = functions.Validate(); err != nil {
			nativeError = err
			return
		}
		native = functions
		for _, initialize := range nativeProfiles {
			if err = initialize(); err != nil {
				nativeError = err
				return
			}
		}
	})
	return nativeError
}
