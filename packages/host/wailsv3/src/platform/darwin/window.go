//go:build darwin

package darwin

/*
#cgo CFLAGS: -x objective-c -fmodules
#cgo LDFLAGS: -framework Cocoa -framework WebKit
#cgo pkg-config: soksak-darwin
#include <stdlib.h>
#include "window_controls.h"
#include "window_facts.h"
#import <Cocoa/Cocoa.h>

void nativeWindowPrepare(void *window);

// 이 창과 이 창에 붙은 창의 윈도 서버 번호를 최대 max 개 기록하고 기록한 수를 반환한다.
// 캡처 도구는 이 번호로 창을 지정하므로, 창을 앞으로 옮기지 않고 윈도 서버가 합성한
// 페이지, 표면과 모달을 읽는다. 이 앱의 창 번호가 처음이다.
static int windowNumbers(void* nsWindow, long* out, int max) {
    NSWindow* window = (NSWindow*)nsWindow;
    if (window == nil || max <= 0) return 0;
    int n = 0;
    out[n++] = (long)[window windowNumber];
    for (NSWindow* child in [window childWindows]) {
        if (n >= max) break;
        out[n++] = (long)[child windowNumber];
    }
    return n;
}
*/
import "C"

import (
	"errors"
	"fmt"
	"unsafe"

	"github.com/min-median-max/soksak/packages/host/wailsv3/src/platform"
)

// implementation 은 macOS 의 platform.Platform 이다.
type implementation struct{}

func init() { platform.Register(implementation{}) }

func (implementation) PrepareWindow(window unsafe.Pointer) error {
	C.nativeWindowPrepare(window)
	return nil
}

func (implementation) PlaceWindowControls(window unsafe.Pointer, x, y float64) error {
	C.windowPlaceControls(window, C.double(x), C.double(y))
	return nil
}

func (implementation) WindowControls(window unsafe.Pointer) (platform.Rect, error) {
	var out [4]C.double
	C.windowControls(window, &out[0])
	return platform.Rect{X: float64(out[0]), Y: float64(out[1]), W: float64(out[2]), H: float64(out[3])}, nil
}

func (implementation) WindowNumbers(window unsafe.Pointer) ([]int, error) {
	var buf [32]C.long
	n := int(C.windowNumbers(window, &buf[0], C.int(len(buf))))
	out := make([]int, n)
	for i := 0; i < n; i++ {
		out[i] = int(buf[i])
	}
	return out, nil
}

// facts 는 native/darwin 이 반환한 JSON 문자열을 Go 문자열로 옮기고 해제한다.
func facts(text *C.char, what string) (string, error) {
	if text == nil {
		return "", fmt.Errorf("%s: the window is gone", what)
	}
	defer C.sp_facts_free(text)
	return C.GoString(text), nil
}

func (implementation) WindowFacts(window unsafe.Pointer) (string, error) {
	return facts(C.sp_window_facts(window), "window state")
}

func (implementation) WindowHit(window unsafe.Pointer, x, y float64) (string, error) {
	return facts(C.sp_window_hit(window, C.double(x), C.double(y)), "window hit testing")
}

func (implementation) MoveWindow(window unsafe.Pointer, x, y float64) error {
	if !C.sp_window_move(window, C.double(x), C.double(y)) {
		return errors.New("window placement: the window is gone")
	}
	return nil
}

func (implementation) Screens() (string, error) {
	return facts(C.sp_screens(), "display list")
}
