//go:build darwin

package darwin

/*
#include <stdbool.h>
#include <stdint.h>
#include <stdlib.h>
#include <string.h>
#include "surface_layout.h"
#include "main_thread.h"

void nativeWindowLayoutBegin(void *window, uint64_t ticket, uintptr_t callback);
void nativeWindowStartPage(void *window, uint64_t ticket, double height, uintptr_t callback);
bool nativeWindowAfterPresentation(void *window, uintptr_t callback);
bool nativeWindowJoinView(void *window, uint64_t ticket, void *view, uintptr_t callback);
bool nativeWindowAfterSettled(void *window, uintptr_t callback);

// The native calls of this file run on the main thread (main_thread.h).
static bool main_surfaceLayoutCommit(void *window, uint64_t ticket) { return ON_MAIN(bool, surfaceLayoutCommit(window, ticket)); }
static void main_surfaceLayoutCancel(void *window) { wailsRunOnMain(^{ surfaceLayoutCancel(window); }); }
static void main_surfaceLayoutCancelTicket(void *window, uint64_t ticket) {
    wailsRunOnMain(^{ surfaceLayoutCancelTicket(window, ticket); });
}
static bool main_surfaceLayoutAbandonView(void *window, void *view) {
    return ON_MAIN(bool, surfaceLayoutAbandonView(window, view));
}
static void main_surfaceLayoutInjectSettledFailure(void) { wailsRunOnMain(^{ surfaceLayoutInjectSettledFailure(); }); }
*/
import "C"

import (
	"errors"
	"runtime/cgo"
	"unsafe"
)

func (implementation) BeginLayout(window unsafe.Pointer, ticket uint64, ready func(bool)) error {
	handle := cgo.NewHandle(ready)
	C.nativeWindowLayoutBegin(window, C.uint64_t(ticket), C.uintptr_t(handle))
	return nil
}

func (implementation) CommitLayout(window unsafe.Pointer, ticket uint64) bool {
	return bool(C.main_surfaceLayoutCommit(window, C.uint64_t(ticket)))
}

func (implementation) CancelLayout(window unsafe.Pointer) error {
	C.main_surfaceLayoutCancel(window)
	return nil
}

func (implementation) CancelLayoutTicket(window unsafe.Pointer, ticket uint64) error {
	C.main_surfaceLayoutCancelTicket(window, C.uint64_t(ticket))
	return nil
}

// JoinView joins the view webview to the layout transaction of window with ticket. The native join ends by the presentation of the
// view or by abandon, whichever comes first. The native side calls the presentation callback only for a join that did not end by
// abandon, and abandon does nothing after the presentation, so the callback handle is released exactly once. The presentation callback
// (_doAfterNextPresentationUpdate) and abandon both run in main-thread steps, whose native calls surfaceLayoutJoinView and
// surfaceLayoutAbandonView assert the main thread, and main-thread steps do not overlap, so ended needs no lock.
func (implementation) JoinView(window unsafe.Pointer, ticket uint64, view unsafe.Pointer, presented func()) (func() error, bool, error) {
	ended := false
	handle := cgo.NewHandle(func() {
		ended = true
		presented()
	})
	if !bool(C.nativeWindowJoinView(window, C.uint64_t(ticket), view, C.uintptr_t(handle))) {
		handle.Delete()
		return nil, false, nil
	}
	abandon := func() error {
		if ended {
			return nil
		}
		ended = true
		handle.Delete()
		if !bool(C.main_surfaceLayoutAbandonView(window, view)) {
			return errors.New("the native layout transaction has no open join of the view")
		}
		return nil
	}
	return abandon, true, nil
}

func (implementation) StartPageTitlebar(window unsafe.Pointer, ticket uint64, height float64, ready func(error)) error {
	handle := cgo.NewHandle(ready)
	C.nativeWindowStartPage(window, C.uint64_t(ticket), C.double(height), C.uintptr_t(handle))
	return nil
}

//export goNativeStartPageReady
func goNativeStartPageReady(value C.uintptr_t, failure *C.char) {
	handle := cgo.Handle(value)
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
	handle := cgo.Handle(value)
	ready := handle.Value().(func(bool))
	handle.Delete()
	ready(bool(allowed))
}

func (implementation) AfterPresentation(window unsafe.Pointer, done func()) error {
	handle := cgo.NewHandle(done)
	if !bool(C.nativeWindowAfterPresentation(window, C.uintptr_t(handle))) {
		handle.Delete()
		return errors.New("native presentation is unavailable")
	}
	return nil
}

//export goNativePresentationDone
func goNativePresentationDone(value C.uintptr_t) {
	handle := cgo.Handle(value)
	done := handle.Value().(func())
	handle.Delete()
	done()
}

func (implementation) AfterSettled(window unsafe.Pointer, done func(displayed float64, err error)) error {
	handle := cgo.NewHandle(done)
	if !bool(C.nativeWindowAfterSettled(window, C.uintptr_t(handle))) {
		handle.Delete()
		return errors.New("native presentation is unavailable")
	}
	return nil
}

func (implementation) InjectSettledFailure(_ unsafe.Pointer) error {
	C.main_surfaceLayoutInjectSettledFailure()
	return nil
}

//export goNativeSettledDone
func goNativeSettledDone(value C.uintptr_t, displayed C.double, message *C.char) {
	handle := cgo.Handle(value)
	done := handle.Value().(func(float64, error))
	handle.Delete()
	if message == nil {
		done(float64(displayed), nil)
		return
	}
	done(0, errors.New(C.GoString(message)))
	C.free(unsafe.Pointer(message))
}
