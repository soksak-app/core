//go:build darwin

package darwin

/*
#cgo CFLAGS: -x objective-c -fmodules
#cgo LDFLAGS: -framework Cocoa -framework WebKit
#cgo pkg-config: soksak-darwin
#include <stdlib.h>
#include "window_controls.h"
#include "window_probe.h"
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

extern void nativeProbeResult(char *);
static void probeToGo(const char *text) { nativeProbeResult((char *)text); }
static void nativeRunProbe(void *window, const char *request) { spNativeProbe(window, request, probeToGo); }
*/
import "C"

import (
	"encoding/json"
	"fmt"
	"sync"
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

// probes 는 결과를 기다리는 검사 요청의 수신 함수다. 요청의 ticket 으로 결과를 구분한다.
var (
	probeMu     sync.Mutex
	probeSerial uint64
	probes      = map[uint64]func(string){}
)

//export nativeProbeResult
func nativeProbeResult(text *C.char) {
	body := C.GoString(text)
	var reply struct {
		Ticket uint64 `json:"ticket"`
	}
	if err := json.Unmarshal([]byte(body), &reply); err != nil {
		return
	}
	probeMu.Lock()
	receive := probes[reply.Ticket]
	delete(probes, reply.Ticket)
	probeMu.Unlock()
	if receive != nil {
		receive(body)
	}
}

func (implementation) Probe(window unsafe.Pointer, request string, reply func(string)) error {
	var fields map[string]any
	if err := json.Unmarshal([]byte(request), &fields); err != nil {
		return fmt.Errorf("native probe request: %w", err)
	}
	probeMu.Lock()
	probeSerial++
	ticket := probeSerial
	probes[ticket] = reply
	probeMu.Unlock()
	fields["ticket"] = ticket
	data, err := json.Marshal(fields)
	if err != nil {
		return err
	}
	text := C.CString(string(data))
	defer C.free(unsafe.Pointer(text))
	C.nativeRunProbe(window, text)
	return nil
}
