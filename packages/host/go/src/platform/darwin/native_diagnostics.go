//go:build darwin && diagnostics

package darwin

import (
	"fmt"
	"github.com/soksak-app/core/packages/host/go/src/platform/darwin/abi"
)

var diagnosticNative abi.DiagnosticFunctions
var diagnosticProvider func(abi.DiagnosticCallbacks) (abi.DiagnosticFunctions, error)

// InstallDiagnosticNativeProvider declares the diagnostics binding before host startup.
func InstallDiagnosticNativeProvider(provider func(abi.DiagnosticCallbacks) (abi.DiagnosticFunctions, error)) error {
	nativeProviderMu.Lock()
	defer nativeProviderMu.Unlock()
	if provider == nil {
		return fmt.Errorf("diagnostic native provider is nil")
	}
	if diagnosticProvider != nil || nativeStarted {
		return fmt.Errorf("diagnostic native provider is already installed or startup has begun")
	}
	diagnosticProvider = provider
	return nil
}

func init() {
	nativeProfiles = append(nativeProfiles, func() error {
		nativeProviderMu.Lock()
		provider := diagnosticProvider
		nativeProviderMu.Unlock()
		if provider == nil {
			return fmt.Errorf("framework adapter has not installed its diagnostic native provider")
		}
		functions, err := provider(diagnosticCallbackHandlers())
		if err != nil {
			return err
		}
		if err = functions.Validate(); err != nil {
			return err
		}
		diagnosticNative = functions
		return nil
	})
}
