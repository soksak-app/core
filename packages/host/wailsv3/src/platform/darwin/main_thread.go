//go:build darwin

package darwin

/*
#include <stdint.h>

extern void wailsRunOnWorker(void (^task)(void));
extern void wailsRunOnMain(void (^call)(void));

static uintptr_t worker(void) { return (uintptr_t)wailsRunOnWorker; }
static uintptr_t mainThread(void) { return (uintptr_t)wailsRunOnMain; }
*/
import "C"

import (
	// The application package of the framework defines the functions above in mainthread_darwin.m and declares them in
	// mainthread_darwin.h, so they are linked into every program that imports this package.
	_ "github.com/wailsapp/wails/v3/pkg/application"

	"github.com/soksak-app/core/packages/host/go/src/platform/darwin"
	"github.com/soksak-app/core/packages/host/go/src/platform/darwin/abi"
	"github.com/soksak-app/core/packages/host/wailsv3/src/platform/darwin/bindings"
)

// The functions are installed before any start of the library (docs/spec/hosts.md, main thread of the Wails host).
func init() {
	if err := darwin.InstallNativeProvider(func(callbacks abi.Callbacks) (abi.NativeFunctions, error) {
		functions := bindings.Functions()
		if err := functions.Validate(); err != nil {
			return abi.NativeFunctions{}, err
		}
		functions.InstallMainThread(uintptr(C.worker()), uintptr(C.mainThread()))
		if err := bindings.InstallCallbacks(callbacks); err != nil {
			return abi.NativeFunctions{}, err
		}
		return functions, nil
	}); err != nil {
		panic(err)
	}
}
