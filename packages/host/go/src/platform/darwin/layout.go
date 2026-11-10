//go:build darwin

package darwin

import (
	"errors"

	"sync"
	"unsafe"

	handles "github.com/soksak-app/core/packages/host/go/src/callback"
	"github.com/soksak-app/core/packages/host/go/src/platform"
)

func (implementation) BeginLayout(window platform.Window, ticket uint64, ready func(bool)) error {
	handle := handles.NewHandle(ready)
	native.NativeWindowLayoutBegin(uintptr(window), uint64(ticket), uintptr(handle))
	return nil
}

func (implementation) CommitLayout(window platform.Window, ticket uint64) bool {
	return bool(native.MainSurfaceLayoutCommit(uintptr(window), uint64(ticket)))
}

func (implementation) CancelLayout(window platform.Window) error {
	native.MainSurfaceLayoutCancel(uintptr(window))
	return nil
}

func (implementation) CancelLayoutTicket(window platform.Window, ticket uint64) error {
	native.MainSurfaceLayoutCancelTicket(uintptr(window), uint64(ticket))
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
	if !bool(native.NativeWindowJoinView(uintptr(window), uint64(ticket), view, uintptr(handle))) {
		handle.Delete()
		return nil, false, nil
	}
	abandon := func() error {
		if ended {
			return nil
		}
		ended = true
		handle.Delete()
		if !bool(native.MainSurfaceLayoutAbandonView(uintptr(window), view)) {
			return errors.New("the native layout transaction has no open join of the view")
		}
		return nil
	}
	return abandon, true, nil
}

// AfterViewPresentation calls presented after the view presented its next frame. The wait of the presentation callback runs in
// its own main-thread step, so it can end after the modal that started it closed; the caller treats a call that never comes as
// a wait that ended without a presentation.
func (implementation) AfterViewPresentation(view unsafe.Pointer, presented func()) bool {
	handle := handles.NewHandle(presented)
	if !bool(native.NativeWebviewAfterPresentation(view, uintptr(handle))) {
		handle.Delete()
		return false
	}
	return true
}

func (implementation) StartPageTitlebar(window platform.Window, ticket uint64, height float64, ready func(error)) error {
	handle := handles.NewHandle(ready)
	native.NativeWindowStartPage(uintptr(window), uint64(ticket), float64(height), uintptr(handle))
	return nil
}

func goHost_native_start_page_ready(value uintptr, failure *byte) {
	handle := handles.Handle(value)
	ready := handle.Value().(func(error))
	handle.Delete()
	if failure == nil {
		ready(nil)
		return
	}
	ready(errors.New(native.GoString(failure)))
}

func goHost_native_layout_ready(value uintptr, allowed bool) {
	handle := handles.Handle(value)
	ready := handle.Value().(func(bool))
	handle.Delete()
	ready(bool(allowed))
}

func (implementation) AfterPresentation(window platform.Window, done func()) error {
	handle := handles.NewHandle(done)
	if !bool(native.NativeWindowAfterPresentation(uintptr(window), uintptr(handle))) {
		handle.Delete()
		return errors.New("native presentation is unavailable")
	}
	return nil
}

func goHost_native_presentation_done(value uintptr) {
	handle := handles.Handle(value)
	done := handle.Value().(func())
	handle.Delete()
	done()
}

func (implementation) MainPresentation(window platform.Window) (unsafe.Pointer, error) {
	present := native.NativeWindowMainPresentation(uintptr(window))
	if present == nil {
		return nil, errors.New("native presentation is unavailable")
	}
	return present, nil
}

func (implementation) AfterSettled(window platform.Window, present unsafe.Pointer, done func(displayed float64, err error)) error {
	native.NativeWindowAfterSettled(uintptr(window), present, uintptr(handles.NewHandle(done)))
	return nil
}

func (implementation) FunctionPresentation(present func(func(error)) error) (unsafe.Pointer, error) {
	return native.NativeFunctionPresentation(uintptr(handles.NewHandle(present))), nil
}

func goHost_native_settled_present(value uintptr, presented unsafe.Pointer) {
	present := handles.Handle(value).Value().(func(func(error)) error)
	var once sync.Once
	finish := func(err error) {
		once.Do(func() {
			var text *byte
			if err != nil {
				text = native.CString(err.Error())
				defer native.Free(unsafe.Pointer(text))
			}
			native.MainSpHostPresentationComplete(presented, text)
		})
	}
	if err := present(finish); err != nil {
		finish(err)
	}
}

func goHost_native_settled_present_ended(value uintptr) { handles.Handle(value).Delete() }

// layoutStarted and layoutEnded are the functions of the observer that ObserveLayout registered.
var layoutStarted, layoutEnded func(window platform.Window)

func (implementation) ObserveLayout(started, ended func(platform.Window)) error {
	layoutStarted, layoutEnded = started, ended
	native.NativeLayoutObserve()
	return nil
}

func goHost_native_layout_started(window uintptr) { layoutStarted(platform.Window(window)) }

func goHost_native_layout_ended(window uintptr) { layoutEnded(platform.Window(window)) }

func (implementation) InjectSettledFailure(platform.Window) error {
	native.MainSurfaceLayoutInjectSettledFailure()
	return nil
}

func goHost_native_settled_done(value uintptr, displayed float64, message *byte) {
	handle := handles.Handle(value)
	done := handle.Value().(func(float64, error))
	handle.Delete()
	if message == nil {
		done(float64(displayed), nil)
		return
	}
	done(0, errors.New(native.GoString(message)))
	native.Free(unsafe.Pointer(message))
}
