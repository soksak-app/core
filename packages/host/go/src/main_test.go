package host

import (
	"os"
	"runtime"
	"sync"
	"testing"
	"unsafe"

	"github.com/ebitengine/purego"

	testplatform "github.com/soksak-app/core/packages/host/go/tests/platform"
)

// An init function runs on the main thread, and the lock keeps the main goroutine there, so the tests of this package that need
// AppKit run on the main thread as the host does (the same pattern as tests/main_test.go).
func init() { runtime.LockOSThread() }

// The tests run on goroutines of their own, and the main goroutine runs the main run loop of the process, which runs the steps
// of the main thread that runOnMainThread queues and the blocks that the native library dispatches to the main queue.
var mainThread struct {
	sync.Mutex
	steps []func()
	loop  uintptr
	// source is the run loop source whose signal runs the queued steps; run, signal, wake and stop are the CoreFoundation functions
	// that run the loop, signal the source, wake the loop and end its run.
	source                uintptr
	run                   func()
	signal, wake, endLoop func(uintptr)
}

// runOnMainThread runs task on the main thread and returns when it returned. It is not reentrant: a task does not call it.
func runOnMainThread(task func()) {
	done := make(chan struct{})
	mainThread.Lock()
	mainThread.steps = append(mainThread.steps, func() {
		defer close(done)
		task()
	})
	mainThread.Unlock()
	mainThread.signal(mainThread.source)
	mainThread.wake(mainThread.loop)
	<-done
}

// runMainThreadSteps runs the queued steps. The run loop calls it on the main thread.
func runMainThreadSteps(uintptr) {
	mainThread.Lock()
	steps := mainThread.steps
	mainThread.steps = nil
	mainThread.Unlock()
	for _, step := range steps {
		step()
	}
}

// mainThreadFramework is the framework of a test that runs the native library: each step runs on the main thread.
type mainThreadFramework struct{ frameworkRecord }

func (mainThreadFramework) Step(task func()) { runOnMainThread(task) }

// startMainRunLoop loads CoreFoundation and adds the source of the steps to the main run loop, with common modes so that the
// main queue of the native library runs in the same loop.
func startMainRunLoop() error {
	library, err := purego.Dlopen("/System/Library/Frameworks/CoreFoundation.framework/CoreFoundation", purego.RTLD_NOW|purego.RTLD_GLOBAL)
	if err != nil {
		return err
	}
	var (
		getMain      func() uintptr
		createSource func(allocator uintptr, order int, context unsafe.Pointer) uintptr
		addSource    func(loop, source, mode uintptr)
	)
	purego.RegisterLibFunc(&getMain, library, "CFRunLoopGetMain")
	purego.RegisterLibFunc(&createSource, library, "CFRunLoopSourceCreate")
	purego.RegisterLibFunc(&addSource, library, "CFRunLoopAddSource")
	purego.RegisterLibFunc(&mainThread.signal, library, "CFRunLoopSourceSignal")
	purego.RegisterLibFunc(&mainThread.wake, library, "CFRunLoopWakeUp")
	purego.RegisterLibFunc(&mainThread.endLoop, library, "CFRunLoopStop")
	purego.RegisterLibFunc(&mainThread.run, library, "CFRunLoopRun")
	commonModes, err := purego.Dlsym(library, "kCFRunLoopCommonModes")
	if err != nil {
		return err
	}
	mainThread.loop = getMain()
	// CFRunLoopSourceContext of version 0: ten words, of which the tenth is the perform function.
	var context [10]uintptr
	context[9] = purego.NewCallback(runMainThreadSteps)
	mainThread.source = createSource(0, 0, unsafe.Pointer(&context[0]))
	addSource(mainThread.loop, mainThread.source, **(**uintptr)(unsafe.Pointer(&commonModes)))
	return nil
}

// TestMain installs the test main-thread function for both functions, because the tests of this package and the sidecars
// that they start run the darwin layer without a framework adapter and a call of a function that is not installed ends the
// process (main_thread.h). The tests run on a goroutine while the main goroutine runs the main run loop.
func TestMain(m *testing.M) {
	testplatform.InstallMainThread()
	if err := startMainRunLoop(); err != nil {
		panic(err)
	}
	finished := make(chan int, 1)
	go func() {
		code := m.Run()
		if !removeViewStore() && code == 0 {
			code = 1
		}
		// The stop is a step, so it ends a loop that runs, and a step that waits for the loop to run is not lost.
		runOnMainThread(func() { mainThread.endLoop(mainThread.loop) })
		finished <- code
	}()
	mainThread.run()
	os.Exit(<-finished)
}
