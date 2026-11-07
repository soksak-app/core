//go:build darwin

package darwin

/*
#include <stdbool.h>
#include <stdint.h>
#include <stdlib.h>
#include <string.h>
#include "surface_layout.h"
#include "main_thread.h"

void nativeWindowLayoutBegin(uintptr_t window, uint64_t ticket, uintptr_t callback);
void nativeWindowStartPage(uintptr_t window, uint64_t ticket, double height, uintptr_t callback);
bool nativeWindowAfterPresentation(uintptr_t window, uintptr_t callback);
bool nativeWindowJoinView(uintptr_t window, uint64_t ticket, void *view, uintptr_t callback);
void *nativeWindowMainPresentation(uintptr_t window);
void nativeWindowAfterSettled(uintptr_t window, void *present, uintptr_t callback);
void *nativeFunctionPresentation(uintptr_t present);
void nativeWindowPresented(void *presented, const char *error);
void nativeLayoutObserve(void);

// The native calls of this file run on the main thread (main_thread.h).
static bool main_surfaceLayoutCommit(uintptr_t window, uint64_t ticket) { return ON_MAIN(bool, surfaceLayoutCommit((void *)window, ticket)); }
static void main_surfaceLayoutCancel(uintptr_t window) { hostRunOnMain(^{ surfaceLayoutCancel((void *)window); }); }
static void main_surfaceLayoutCancelTicket(uintptr_t window, uint64_t ticket) {
    hostRunOnMain(^{ surfaceLayoutCancelTicket((void *)window, ticket); });
}
static bool main_surfaceLayoutAbandonView(uintptr_t window, void *view) {
    return ON_MAIN(bool, surfaceLayoutAbandonView((void *)window, view));
}
static void main_surfaceLayoutInjectSettledFailure(void) { hostRunOnMain(^{ surfaceLayoutInjectSettledFailure(); }); }
*/
import "C"

import (
	"errors"

	"sync"
	"unsafe"

	handles "github.com/soksak-app/core/packages/host/go/src/callback"
	"github.com/soksak-app/core/packages/host/go/src/platform"
)

func (implementation) BeginLayout(window platform.Window, ticket uint64, ready func(bool)) error {
	handle := handles.NewHandle(ready)
	C.nativeWindowLayoutBegin(C.uintptr_t(window), C.uint64_t(ticket), C.uintptr_t(handle))
	return nil
}

func (implementation) CommitLayout(window platform.Window, ticket uint64) bool {
	return bool(C.main_surfaceLayoutCommit(C.uintptr_t(window), C.uint64_t(ticket)))
}

func (implementation) CancelLayout(window platform.Window) error {
	C.main_surfaceLayoutCancel(C.uintptr_t(window))
	return nil
}

func (implementation) CancelLayoutTicket(window platform.Window, ticket uint64) error {
	C.main_surfaceLayoutCancelTicket(C.uintptr_t(window), C.uint64_t(ticket))
	return nil
}

// JoinView joins the view webview to the layout transaction of window with ticket. The native join ends by the presentation of the
// view or by abandon, whichever comes first. The native side calls the presentation callback only for a join that did not end by
// abandon, and abandon does nothing after the presentation, so the callback handle is released exactly once. The presentation callback
// (_doAfterNextPresentationUpdate) and abandon both run in main-thread steps, whose native calls surfaceLayoutJoinView and
// surfaceLayoutAbandonView assert the main thread, and main-thread steps do not overlap, so ended needs no lock.
func (implementation) JoinView(window platform.Window, ticket uint64, view unsafe.Pointer, presented func()) (func() error, bool, error) {
	ended := false
	handle := handles.NewHandle(func() {
		ended = true
		presented()
	})
	if !bool(C.nativeWindowJoinView(C.uintptr_t(window), C.uint64_t(ticket), view, C.uintptr_t(handle))) {
		handle.Delete()
		return nil, false, nil
	}
	abandon := func() error {
		if ended {
			return nil
		}
		ended = true
		handle.Delete()
		if !bool(C.main_surfaceLayoutAbandonView(C.uintptr_t(window), view)) {
			return errors.New("the native layout transaction has no open join of the view")
		}
		return nil
	}
	return abandon, true, nil
}

func (implementation) StartPageTitlebar(window platform.Window, ticket uint64, height float64, ready func(error)) error {
	handle := handles.NewHandle(ready)
	C.nativeWindowStartPage(C.uintptr_t(window), C.uint64_t(ticket), C.double(height), C.uintptr_t(handle))
	return nil
}

//export goNativeStartPageReady
func goNativeStartPageReady(value C.uintptr_t, failure *C.char) {
	handle := handles.Handle(value)
	ready := handle.Value().(func(error))
	handle.Delete()
	if failure == nil {
		ready(nil)
		return
	}
	ready(errors.New(C.GoString(failure)))
}

//export goNativeLayoutReady
func goNativeLayoutReady(value C.uintptr_t, allowed C.bool) {
	handle := handles.Handle(value)
	ready := handle.Value().(func(bool))
	handle.Delete()
	ready(bool(allowed))
}

func (implementation) AfterPresentation(window platform.Window, done func()) error {
	handle := handles.NewHandle(done)
	if !bool(C.nativeWindowAfterPresentation(C.uintptr_t(window), C.uintptr_t(handle))) {
		handle.Delete()
		return errors.New("native presentation is unavailable")
	}
	return nil
}

//export goNativePresentationDone
func goNativePresentationDone(value C.uintptr_t) {
	handle := handles.Handle(value)
	done := handle.Value().(func())
	handle.Delete()
	done()
}

func (implementation) MainPresentation(window platform.Window) (unsafe.Pointer, error) {
	present := C.nativeWindowMainPresentation(C.uintptr_t(window))
	if present == nil {
		return nil, errors.New("native presentation is unavailable")
	}
	return present, nil
}

func (implementation) AfterSettled(window platform.Window, present unsafe.Pointer, done func(displayed float64, err error)) error {
	C.nativeWindowAfterSettled(C.uintptr_t(window), present, C.uintptr_t(handles.NewHandle(done)))
	return nil
}

func (implementation) FunctionPresentation(present func(func(error)) error) (unsafe.Pointer, error) {
	return C.nativeFunctionPresentation(C.uintptr_t(handles.NewHandle(present))), nil
}

//export goNativeSettledPresent
func goNativeSettledPresent(value C.uintptr_t, presented unsafe.Pointer) {
	present := handles.Handle(value).Value().(func(func(error)) error)
	var once sync.Once
	finish := func(err error) {
		once.Do(func() {
			var text *C.char
			if err != nil {
				text = C.CString(err.Error())
				defer C.free(unsafe.Pointer(text))
			}
			C.nativeWindowPresented(presented, text)
		})
	}
	if err := present(finish); err != nil {
		finish(err)
	}
}

//export goNativeSettledPresentEnded
func goNativeSettledPresentEnded(value C.uintptr_t) { handles.Handle(value).Delete() }

// layoutStarted and layoutEnded are the functions of the observer that ObserveLayout registered.
var layoutStarted, layoutEnded func(window platform.Window)

func (implementation) ObserveLayout(started, ended func(platform.Window)) error {
	layoutStarted, layoutEnded = started, ended
	C.nativeLayoutObserve()
	return nil
}

//export goNativeLayoutStarted
func goNativeLayoutStarted(window C.uintptr_t) { layoutStarted(platform.Window(window)) }

//export goNativeLayoutEnded
func goNativeLayoutEnded(window C.uintptr_t) { layoutEnded(platform.Window(window)) }

func (implementation) InjectSettledFailure(platform.Window) error {
	C.main_surfaceLayoutInjectSettledFailure()
	return nil
}

//export goNativeSettledDone
func goNativeSettledDone(value C.uintptr_t, displayed C.double, message *C.char) {
	handle := handles.Handle(value)
	done := handle.Value().(func(float64, error))
	handle.Delete()
	if message == nil {
		done(float64(displayed), nil)
		return
	}
	done(0, errors.New(C.GoString(message)))
	C.free(unsafe.Pointer(message))
}
