//go:build darwin

package system_test

import (
	"fmt"
	"sync"
	"time"
	"unsafe"

	"github.com/ebitengine/purego"
)

// The tests of the stall watch run the main run loop of the child process on its main thread: the watch sends a heartbeat that the
// main run loop answers, and a run loop that is not run answers none. The system library CoreFoundation runs it.

const (
	coreFoundation = "/System/Library/Frameworks/CoreFoundation.framework/CoreFoundation"
	// cfStringEncodingUTF8 is kCFStringEncodingUTF8.
	cfStringEncodingUTF8 = 0x08000100
	// cfRunLoopRunTimedOut is kCFRunLoopRunTimedOut, the result of a run that lasted its whole time.
	cfRunLoopRunTimedOut = 3
	// cfRunLoopDefaultMode is the name of kCFRunLoopDefaultMode.
	cfRunLoopDefaultMode = "kCFRunLoopDefaultMode"
)

var (
	runLoopOnce  sync.Once
	runLoopError error
	runLoopMode  uintptr
	runLoopRun   func(mode uintptr, seconds float64, returnAfterSourceHandled bool) int32
)

// loadRunLoop loads the run loop functions and adds one source with no work to the default mode of the main run loop: a run loop
// whose mode has no source returns at once instead of waiting.
func loadRunLoop() {
	library, err := purego.Dlopen(coreFoundation, purego.RTLD_NOW|purego.RTLD_GLOBAL)
	if err != nil {
		runLoopError = err
		return
	}
	var (
		createString func(allocator uintptr, text string, encoding uint32) uintptr
		getMain      func() uintptr
		createSource func(allocator uintptr, order int, context unsafe.Pointer) uintptr
		addSource    func(loop, source, mode uintptr)
	)
	purego.RegisterLibFunc(&createString, library, "CFStringCreateWithCString")
	purego.RegisterLibFunc(&getMain, library, "CFRunLoopGetMain")
	purego.RegisterLibFunc(&createSource, library, "CFRunLoopSourceCreate")
	purego.RegisterLibFunc(&addSource, library, "CFRunLoopAddSource")
	purego.RegisterLibFunc(&runLoopRun, library, "CFRunLoopRunInMode")
	runLoopMode = createString(0, cfRunLoopDefaultMode, cfStringEncodingUTF8)
	// CFRunLoopSourceContext of version 0 with no callback: ten zero words.
	var context [10]uintptr
	source := createSource(0, 0, unsafe.Pointer(&context[0]))
	if runLoopMode == 0 || source == 0 {
		runLoopError = fmt.Errorf("the run loop mode or its source was not created")
		return
	}
	addSource(getMain(), source, runLoopMode)
}

// pumpRunLoop runs the run loop of the calling thread, which must be the main thread, for duration. The run loop waits for an event
// while it has none, and wakes when the time ends.
func pumpRunLoop(duration time.Duration) error {
	runLoopOnce.Do(loadRunLoop)
	if runLoopError != nil {
		return runLoopError
	}
	if result := runLoopRun(runLoopMode, duration.Seconds(), false); result != cfRunLoopRunTimedOut {
		return fmt.Errorf("the run loop ended with result %d before its time of %v", result, duration)
	}
	return nil
}
