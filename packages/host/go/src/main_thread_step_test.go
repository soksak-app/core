package host

import (
	"github.com/ebitengine/purego"
)

// callerIsMainThread is pthread_main_np of the system library: it tells whether the calling thread is the main thread of the process,
// which runs the main run loop of the tests (TestMain).
var callerIsMainThread func() int32

func init() {
	library, err := purego.Dlopen("/usr/lib/libSystem.B.dylib", purego.RTLD_NOW|purego.RTLD_GLOBAL)
	if err != nil {
		panic(err)
	}
	purego.RegisterLibFunc(&callerIsMainThread, library, "pthread_main_np")
}

// stepOnMainThread runs task on the main thread, as the step of a framework does: at once when the caller is the main thread, which a
// step inside a step is, and as a step of the main run loop otherwise.
func stepOnMainThread(task func()) {
	if callerIsMainThread() != 0 {
		task()
		return
	}
	runOnMainThread(task)
}
