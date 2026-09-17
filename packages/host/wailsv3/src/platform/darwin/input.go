//go:build darwin

package darwin

/*
#include <stdbool.h>
#include <stdint.h>
#include <stdlib.h>
#include "input_inject.h"
#import <Cocoa/Cocoa.h>

extern void inputActivated(void *context, int result, char *frontmost);
static void activated(void *context, sp_activate_result result, const char *frontmost) {
    inputActivated(context, (int)result, (char *)frontmost);
}
static void activateWindow(void *window, double timeout, uintptr_t handle) {
    sp_input_activate(window, timeout, activated, (void *)handle);
}

extern void inputDelivered(void *context, int result);
static void delivered(void *context, sp_input_result result) { inputDelivered(context, (int)result); }
static void injectPointer(void *window, double x, double y, int phase, int button, double deltaX, double deltaY,
    double receive, uintptr_t handle) {
    sp_input_pointer_then(window, x, y, phase, button, deltaX, deltaY, receive, delivered, (void *)handle);
}

// 누름이 지나가는 뷰 하나가 표면인지 알린다. 표면이면 0 이 아닌 값을 반환하고, 적중한
// 뷰에서 위로 올라가는 탐색은 거기서 멈춘다.
extern int surfaceHit(uintptr_t owner, void* view);

// 왼쪽 단추 끌기의 한 단계를 페이지 좌표로 알린다. phase 는 누름 0, 이동 1, 뗌 2 이다.
extern void surfacePoint(uintptr_t owner, int phase, double x, double y);

// 뷰에서 콘텐츠 뷰까지 올라가며 첫 표면을 알린다. 표면을 찾았는지 반환한다. 이 값은
// 입력이 페이지가 아니라 이 앱의 뷰에서 시작했는지를 나타낸다.
static int surfaceWalk(uintptr_t owner, NSView* view, NSView* content) {
    while (view != nil && view != content) {
        if (surfaceHit(owner, (void*)view)) {
            return 1;
        }
        view = [view superview];
    }
    return 0;
}

// 표면은 네이티브 뷰이므로 표면 위의 입력은 페이지에 도달하지 않는다. 앱의 모니터
// 하나가 모든 누름, 끌기와 키 입력을 받아 입력 대상 뷰와 위치를 알린다.
//
// 누름의 대상은 hitTest: 로 찾는다. 키 입력의 대상은 창의 first responder 이고, 스스로
// 초점을 잡은 페이지가 first responder 가 된다. google.com 은 로드할 때 검색 칸에 초점을
// 두므로, 이 처리가 없으면 페이지 모델은 마지막으로 누른 표면을 계속 가리킨다. 두 경우
// 모두 좌표를 변환하지 않으므로 페이지의 영역과 어긋나지 않는다.
//
// 끌기의 위치는 변환해야 한다. 경계의 잡기 영역은 두 카드 사이 통로보다 넓으므로, 통로
// 폭이 선 하나이면 그 영역 전체가 표면 위에 있어 그 안의 누름이 페이지에 도달하지 않는다.
// 페이지가 위치의 의미를 결정하고, 이 함수는 페이지 뷰가 채운 콘텐츠 뷰의 높이로 페이지
// 좌표를 계산한다.
//
// 페이지에서 시작한 끌기는 페이지가 처리하므로 전달하지 않는다. 전달하면 포인터 이동마다
// 평면을 다시 그리는 스레드에 메시지가 하나씩 쌓인다.
//
// 모니터는 이벤트를 바꾸지 않고 반환하므로 뷰도 이벤트를 받는다.
static uintptr_t surfaceWatchMouse(void* nsWindow, uintptr_t owner) {
    __block int surfaceDragging = 0;
    NSWindow* window = (NSWindow*)nsWindow;
    NSEventMask mask = NSEventMaskLeftMouseDown | NSEventMaskLeftMouseDragged
                     | NSEventMaskLeftMouseUp | NSEventMaskKeyDown;
    return (uintptr_t)[NSEvent addLocalMonitorForEventsMatchingMask:mask
                                          handler:^NSEvent*(NSEvent* event) {
        if ([event window] == window) {
            NSView* content = [window contentView];
            NSEventType type = [event type];
            if (type == NSEventTypeKeyDown) {
                NSResponder* first = [window firstResponder];
                if ([first isKindOfClass:[NSView class]]) {
                    surfaceWalk(owner, (NSView*)first, content);
                }
            } else {
                NSPoint at = [event locationInWindow];
                double x = at.x;
                double y = [content bounds].size.height - at.y;
                if (type == NSEventTypeLeftMouseDown) {
                    surfaceDragging = surfaceWalk(owner, [content hitTest:at], content);
                    if (surfaceDragging) surfacePoint(owner, 0, x, y);
                } else if (surfaceDragging) {
                    surfacePoint(owner, type == NSEventTypeLeftMouseDragged ? 1 : 2, x, y);
                    if (type == NSEventTypeLeftMouseUp) surfaceDragging = 0;
                }
            }
        }
        return event;
    }];
}

static void surfaceUnwatchMouse(uintptr_t monitor) { if (monitor) [NSEvent removeMonitor:(id)monitor]; }
*/
import "C"

import (
	"errors"
	"fmt"
	"runtime/cgo"
	"unsafe"

	"github.com/min-median-max/soksak/packages/host/wailsv3/src/platform"
)

// watchers 는 모니터 번호별 입력 수신 핸들이다. 주 스레드에서만 읽고 바꾼다.
var watchers = map[uintptr]cgo.Handle{}

//export surfaceHit
func surfaceHit(owner C.uintptr_t, view unsafe.Pointer) C.int {
	if cgo.Handle(owner).Value().(platform.Input).Press(uintptr(view)) {
		return 1
	}
	return 0
}

//export surfacePoint
func surfacePoint(owner C.uintptr_t, phase C.int, x C.double, y C.double) {
	cgo.Handle(owner).Value().(platform.Input).Point(int(phase), float64(x), float64(y))
}

func (implementation) WatchInput(window unsafe.Pointer, input platform.Input) (uintptr, error) {
	handle := cgo.NewHandle(input)
	monitor := uintptr(C.surfaceWatchMouse(window, C.uintptr_t(handle)))
	watchers[monitor] = handle
	return monitor, nil
}

// InjectPointer 는 native/darwin 의 sp_input_pointer_then 으로 입력을 전달한다. 앱을 활성화하지 않는다.
func (implementation) InjectPointer(window unsafe.Pointer, x, y float64, phase, button int, deltaX, deltaY, receive float64, done func(platform.PointerResult)) error {
	C.injectPointer(window, C.double(x), C.double(y), C.int(phase), C.int(button), C.double(deltaX), C.double(deltaY),
		C.double(receive), C.uintptr_t(cgo.NewHandle(done)))
	return nil
}

//export inputDelivered
func inputDelivered(context unsafe.Pointer, result C.int) {
	handle := cgo.Handle(uintptr(context))
	done := handle.Value().(func(platform.PointerResult))
	handle.Delete()
	switch C.sp_input_result(result) {
	case C.SP_INPUT_DELIVERED:
		done(platform.PointerDelivered)
	case C.SP_INPUT_INACTIVE:
		done(platform.PointerInactive)
	case C.SP_INPUT_UNRECEIVED:
		done(platform.PointerUnreceived)
	default:
		done(platform.PointerRejected)
	}
}

type activation struct {
	timeout float64
	done    func(error)
}

//export inputActivated
func inputActivated(context unsafe.Pointer, result C.int, frontmost *C.char) {
	handle := cgo.Handle(uintptr(context))
	a := handle.Value().(activation)
	handle.Delete()
	name := "unknown"
	if frontmost != nil {
		name = C.GoString(frontmost)
	}
	a.done(activationResult(C.sp_activate_result(result), a.timeout, name))
}

// activationResult 는 sp_input_activate 의 결과를 멈춘 단계와 최전면 애플리케이션을 적은 오류로 바꾼다.
func activationResult(result C.sp_activate_result, timeout float64, frontmost string) error {
	switch result {
	case C.SP_ACTIVATE_DONE:
		return nil
	case C.SP_ACTIVATE_REFUSED:
		return fmt.Errorf("the system did not activate the application within %gs; the frontmost application is %s", timeout, frontmost)
	case C.SP_ACTIVATE_NOT_KEY:
		return fmt.Errorf("the application is active but the window did not become key within %gs; the frontmost application is %s", timeout, frontmost)
	case C.SP_ACTIVATE_PENDING:
		return fmt.Errorf("the window's webviews did not apply the active state within %gs", timeout)
	case C.SP_ACTIVATE_LOST:
		return fmt.Errorf("the window lost activation before its webviews applied it; the frontmost application is %s", frontmost)
	default:
		return errors.New("the window cannot be activated")
	}
}

// ActivateWindow 는 native/darwin 의 sp_input_activate 로 창을 키 창으로 만든다.
func (implementation) ActivateWindow(window unsafe.Pointer, timeout float64, done func(error)) error {
	C.activateWindow(window, C.double(timeout), C.uintptr_t(cgo.NewHandle(activation{timeout, done})))
	return nil
}

// InjectKey 는 native/darwin 의 sp_input_key 로 입력을 전달한다. text 가 비어 있으면 key 를 입력한다.
func (implementation) InjectKey(window unsafe.Pointer, key, text string, modifiers uint, down bool) (bool, error) {
	name := C.CString(key)
	defer C.free(unsafe.Pointer(name))
	var typed *C.char
	if text != "" {
		typed = C.CString(text)
		defer C.free(unsafe.Pointer(typed))
	}
	return bool(C.sp_input_key(window, name, typed, C.uint(modifiers), C.bool(down))), nil
}

func (implementation) UnwatchInput(monitor uintptr) {
	if handle, ok := watchers[monitor]; ok {
		C.surfaceUnwatchMouse(C.uintptr_t(monitor))
		handle.Delete()
		delete(watchers, monitor)
	}
}
