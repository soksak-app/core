//go:build darwin

package darwin

/*
#include <stdbool.h>
#include <stdint.h>
#include <stdlib.h>
#include <string.h>
#include "surface_layout.h"

void nativeWindowLayoutBegin(void *window, uint64_t ticket, uintptr_t callback);
void nativeWindowStartPage(void *window, uint64_t ticket, double height, uintptr_t callback);
bool nativeWindowAfterPresentation(void *window, uintptr_t callback);
bool nativeWindowJoinView(void *window, uint64_t ticket, void *view, uintptr_t callback);
bool surfaceLayoutAbandonView(void *owner, void *viewWebview);
bool nativeWindowAfterSettled(void *window, uintptr_t callback);
void surfaceLayoutInjectSettledFailure(void);
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
	return bool(C.surfaceLayoutCommit(window, C.uint64_t(ticket)))
}

func (implementation) CancelLayout(window unsafe.Pointer) error {
	C.surfaceLayoutCancel(window)
	return nil
}

// JoinView joins the view webview to the layout transaction of window with ticket. The native join ends by the presentation of the
// view or by abandon, whichever comes first. The native side calls the presentation callback only for a join that did not end by
// abandon, and abandon does nothing after the presentation, so the callback handle is released exactly once.
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
		if !bool(C.surfaceLayoutAbandonView(window, view)) {
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

//export nativeStartPageReady
func nativeStartPageReady(value C.uintptr_t, failure *C.char) {
	handle := cgo.Handle(value)
	ready := handle.Value().(func(error))
	handle.Delete()
	if failure == nil {
		ready(nil)
		return
	}
	ready(errors.New(C.GoString(failure)))
}

//export nativeLayoutReady
func nativeLayoutReady(value C.uintptr_t, allowed C.bool) {
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

//export nativePresentationDone
func nativePresentationDone(value C.uintptr_t) {
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
	C.surfaceLayoutInjectSettledFailure()
	return nil
}

//export nativeSettledDone
func nativeSettledDone(value C.uintptr_t, displayed C.double, message *C.char) {
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
