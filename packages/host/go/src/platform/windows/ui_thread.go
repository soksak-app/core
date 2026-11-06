//go:build windows

package windows

import (
	"fmt"
	"os"
	"sync"
	"syscall"
	"time"
	"unsafe"

	sys "golang.org/x/sys/windows"
)

var (
	user32   = sys.NewLazySystemDLL("user32.dll")
	kernel32 = sys.NewLazySystemDLL("kernel32.dll")
	ole32    = sys.NewLazySystemDLL("ole32.dll")

	procRegisterClassExW      = user32.NewProc("RegisterClassExW")
	procCreateWindowExW       = user32.NewProc("CreateWindowExW")
	procDefWindowProcW        = user32.NewProc("DefWindowProcW")
	procPostMessageW          = user32.NewProc("PostMessageW")
	procIsIconic              = user32.NewProc("IsIconic")
	procIsWindowVisible       = user32.NewProc("IsWindowVisible")
	procIsWindow              = user32.NewProc("IsWindow")
	procSetForegroundWindow   = user32.NewProc("SetForegroundWindow")
	procGetForegroundWindow   = user32.NewProc("GetForegroundWindow")
	procGetModuleHandleW      = kernel32.NewProc("GetModuleHandleW")
	procCreateStreamOnHGlobal = ole32.NewProc("CreateStreamOnHGlobal")
)

const (
	hwndMessage = ^uintptr(2) // HWND_MESSAGE, (HWND)-3
	wmRunTasks  = 0x8000 + 1  // WM_APP + 1
)

type windowClass struct {
	size, style                        uint32
	proc                               uintptr
	classExtra, windowExtra            int32
	instance, icon, cursor, background uintptr
	menuName, className                *uint16
	iconSmall                          uintptr
}

// uiThread is the thread of the web views. COM calls of a web view and its completions belong to that thread.
var uiThread struct {
	mu     sync.Mutex
	window uintptr
	thread uint32
}

// uiTasks is the queue of the UI thread.
var uiTasks = uiQueue{
	after: func(wait time.Duration, fire func()) { time.AfterFunc(wait, fire) },
	report: func(err error) {
		// A delayed task has no caller to answer, and the queue tries again.
		fmt.Fprintf(os.Stderr, "UI task: %v\n", err)
	},
}

// createMessageWindow registers a window class of that name and creates a message-only window of it on this thread.
func createMessageWindow(className string, proc uintptr) (uintptr, error) {
	name, err := sys.UTF16PtrFromString(className)
	if err != nil {
		return 0, err
	}
	instance, _, err := procGetModuleHandleW.Call(0)
	if instance == 0 {
		return 0, fmt.Errorf("module: %w", err)
	}
	class := windowClass{instance: instance, proc: proc, className: name}
	class.size = uint32(unsafe.Sizeof(class))
	if atom, _, err := procRegisterClassExW.Call(uintptr(unsafe.Pointer(&class))); atom == 0 {
		return 0, fmt.Errorf("class: %w", err)
	}
	window, _, err := procCreateWindowExW.Call(0, uintptr(unsafe.Pointer(name)), 0, 0, 0, 0, 0, 0, hwndMessage, 0, instance, 0)
	if window == 0 {
		return 0, fmt.Errorf("creation: %w", err)
	}
	return window, nil
}

// startUIThread makes the calling thread the thread that post runs tasks on. Call it on the UI thread.
var startUIThread = sync.OnceValue(func() error {
	window, err := createMessageWindow("soksak-ui-tasks", syscall.NewCallback(func(window, message, wParam, lParam uintptr) uintptr {
		if message != wmRunTasks {
			// default: DefWindowProcW sets no error that GetLastError reads, so its value is the whole answer and the error of Call holds nothing.
			result, _, _ := procDefWindowProcW.Call(window, message, wParam, lParam)
			return result
		}
		uiTasks.run()
		return 0
	}))
	if err != nil {
		return fmt.Errorf("UI task window: %w", err)
	}
	uiThread.mu.Lock()
	uiThread.window, uiThread.thread = window, sys.GetCurrentThreadId()
	uiThread.mu.Unlock()
	uiTasks.mu.Lock()
	uiTasks.wake = func() error {
		if posted, _, err := procPostMessageW.Call(window, wmRunTasks, 0, 0); posted == 0 {
			return err
		}
		return nil
	}
	uiTasks.mu.Unlock()
	return nil
})

// onUIThread tells whether the caller runs on the UI thread.
func onUIThread() bool {
	uiThread.mu.Lock()
	defer uiThread.mu.Unlock()
	return uiThread.window != 0 && uiThread.thread == sys.GetCurrentThreadId()
}

// post runs task as a later step of the UI thread. It runs in the message loop, so it works from any thread.
func post(task func()) error {
	return uiTasks.add(task)
}

// afterOnUIThread runs task on the UI thread after a wait, unless the returned function cancels it. A cancel on the UI thread is final,
// because the task checks the same flag there.
func afterOnUIThread(wait time.Duration, task func()) (cancel func()) {
	canceled := false
	var timer *time.Timer
	fire := func() {
		err := post(func() {
			if !canceled {
				task()
			}
		})
		if err != nil {
			// A full message queue refuses the message, and a wait must still end.
			fmt.Fprintf(os.Stderr, "UI task: %v\n", err)
			timer.Reset(uiPostRetry)
		}
	}
	timer = time.AfterFunc(wait, fire)
	return func() {
		canceled = true
		timer.Stop()
	}
}

// EnqueueUI runs work once as a later step of the UI thread, in the order of the calls.
func (implementation) EnqueueUI(work func()) error {
	return uiTasks.add(work)
}

// EnqueueUIAfter runs work once as a later step of the UI thread after delay.
func (implementation) EnqueueUIAfter(delay time.Duration, work func()) error {
	return uiTasks.addAfter(delay, work)
}
