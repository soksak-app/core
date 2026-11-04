//go:build darwin

package darwin

/*
extern void wailsRunOnWorker(void (^task)(void));
extern void wailsRunOnMain(void (^call)(void));

static void *worker(void) { return (void *)wailsRunOnWorker; }
static void *mainThread(void) { return (void *)wailsRunOnMain; }
*/
import "C"

import (
	// The application package of the framework defines the functions above in mainthread_darwin.m and declares them in
	// mainthread_darwin.h, so they are linked into every program that imports this package.
	_ "github.com/wailsapp/wails/v3/pkg/application"

	"github.com/soksak-app/core/packages/host/go/src/platform/darwin"
)

// The functions are installed before any start of the library (docs/spec/hosts.md, main thread of the Wails host).
func init() { darwin.InstallMainThread(C.worker(), C.mainThread()) }
