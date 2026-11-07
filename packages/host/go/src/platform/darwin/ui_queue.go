//go:build darwin

package darwin

import (
	"fmt"

	"strings"
	"time"

	handles "github.com/soksak-app/core/packages/host/go/src/callback"
)

func (implementation) RequireMainThread() error {
	if err := ensureNative(); err != nil {
		return err
	}
	var worker, main bool
	native.MainThreadInstalled(&worker, &main)
	var missing []string
	if !worker {
		missing = append(missing, "hostRunOnWorker")
	}
	if !main {
		missing = append(missing, "hostRunOnMain")
	}
	if len(missing) == 0 {
		return nil
	}
	return fmt.Errorf("main-thread functions are not installed: %s; the framework adapter installs them through its native provider before the start of the library", strings.Join(missing, " and "))
}

func (implementation) EnqueueUI(work func()) error {
	handle := handles.NewHandle(work)
	native.UiEnqueue(uintptr(handle))
	return nil
}

func (implementation) EnqueueUIAfter(delay time.Duration, work func()) error {
	if delay < 0 {
		return fmt.Errorf("UI queue delay %s is negative", delay)
	}
	handle := handles.NewHandle(work)
	native.UiEnqueueAfter(uint64(delay.Nanoseconds()), uintptr(handle))
	return nil
}

func goHost_native_ui_run(context uintptr) {
	handle := handles.Handle(context)
	work := handle.Value().(func())
	handle.Delete()
	work()
}
