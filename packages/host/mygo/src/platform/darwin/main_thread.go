//go:build darwin

package darwin

import (
	"unsafe"

	"github.com/ebitengine/purego"
	"github.com/egoist/mygo"
	common "github.com/soksak-app/core/packages/host/go/src/platform/darwin"
	"github.com/soksak-app/core/packages/host/go/src/platform/darwin/abi"
	"github.com/soksak-app/core/packages/host/mygo/src/platform/darwin/bindings"
	"github.com/soksak-app/core/packages/host/mygo/src/platform/darwin/nativecallback"
)

func init() {
	if err := common.InstallNativeProvider(func(callbacks abi.Callbacks) (abi.NativeFunctions, error) {
		library, err := nativeLibrary()
		if err != nil {
			return abi.NativeFunctions{}, err
		}
		functions, err := bindings.Functions(library)
		if err != nil {
			return abi.NativeFunctions{}, err
		}
		if err = functions.Validate(); err != nil {
			return abi.NativeFunctions{}, err
		}
		functions.InstallMainThread(mygo.RunOnWorkerAddress(), mygo.RunOnMainAddress())
		// Resolve before allocating addresses from purego's permanent callback pool.
		address, err := requiredSymbol(library, "sp_host_callbacks_install")
		if err != nil {
			return abi.NativeFunctions{}, err
		}
		var install func(unsafe.Pointer) *byte
		purego.RegisterFunc(&install, address)
		table, err := nativecallback.Bind(callbacks)
		if err != nil {
			return abi.NativeFunctions{}, err
		}
		if err = callbackInstallError(install(unsafe.Pointer(&table[0]))); err != nil {
			return abi.NativeFunctions{}, err
		}
		return functions, nil
	}); err != nil {
		panic(err)
	}
}
