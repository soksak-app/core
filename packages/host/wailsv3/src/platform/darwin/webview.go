//go:build darwin

package darwin

/*
#include <stdbool.h>
#include <stdlib.h>
#include "webview_geometry.h"
#import <Cocoa/Cocoa.h>
#import <WebKit/WebKit.h>

void *nativeWebviewCreate(void *window, unsigned long long identifier, const char *script,
    double x, double y, double width, double height, bool hidden, bool transparent, bool fillParent);
bool nativeWebviewNavigate(void *view, const char *url);
void nativeWebviewBounds(void *view, double x, double y, double width, double height);
void nativeWebviewHidden(void *view, bool hidden);
void nativeWebviewBackground(void *view, bool enabled);
void nativeWebviewEval(void *view, const char *script);
void nativeWebviewClose(void *view);

// 연속적인 표면 크기 변경의 시작과 종료를 웹뷰에 전달한다.
static void surfaceBeginLiveResize(void* handle) {
    [(WKWebView*)handle viewWillStartLiveResize];
}

static void surfaceEndLiveResize(void* handle) {
    [(WKWebView*)handle viewDidEndLiveResize];
}

// 모달은 메인 창 안의 WKWebView 다. 레이어가 모서리를 자르고, 모달의 위치와 초점은
// OS 창 계층을 바꾸지 않는다.
static void modalViewConfigure(void* handle, const char* title, double radius) {
    NSView* view = (NSView*)handle;
    [view setWantsLayer:YES];
    view.layer.cornerRadius = radius;
    view.layer.masksToBounds = YES;
    if (title != NULL) [view setAccessibilityLabel:[NSString stringWithUTF8String:title]];
}

static void modalViewFocus(void* handle, int take) {
    NSView* view = (NSView*)handle;
    NSWindow* window = view.window;
    if (window == nil) return;
    if (take) {
        [view.superview addSubview:view positioned:NSWindowAbove relativeTo:nil];
        [window makeFirstResponder:view];
        return;
    }
    for (NSView* candidate in window.contentView.subviews) {
        if (candidate != view && [candidate isKindOfClass:[WKWebView class]]) {
            [window makeFirstResponder:candidate];
            return;
        }
    }
}

// 페이지 좌표의 모달 영역을 디스플레이 픽셀 격자에 안쪽으로 맞춘다. 바깥쪽으로 맞추면
// 표면과 마찬가지로 카드의 테두리를 덮는다.
static void modalAligned(void* parentWindow, double x, double y, double w, double h,
                         double* out) {
    NSWindow* parent = (NSWindow*)parentWindow;
    if (parent == nil) return;
    NSView* content = [parent contentView];
    if (content == nil) return;
    double up = content.bounds.size.height - y - h;
    NSRect r = [parent backingAlignedRect:NSMakeRect(x, up, w, h)
                                  options:NSAlignAllEdgesInward];
    out[0] = r.origin.x;
    out[1] = content.bounds.size.height - r.origin.y - r.size.height;
    out[2] = r.size.width;
    out[3] = r.size.height;
}

// 뷰의 불투명도를 정한다. 페이지는 초점을 잃은 표면을 흐리게 표시한다.
*/
import "C"

import (
	"fmt"
	"unsafe"

	"github.com/min-median-max/soksak/packages/host/wailsv3/src/platform"
)

// receive 와 committed 는 마지막으로 만든 웹뷰의 수신 함수다. 호스트는 모든 웹뷰에 같은 함수를 전달한다.
var receive func(identifier uint64, body string)
var committed func(identifier uint64)

//export nativeCommitted
func nativeCommitted(identifier C.ulonglong) {
	handler := committed
	if handler == nil {
		return
	}
	// 수신자는 주 스레드를 기다릴 수 있다. 호출하기 전에 WebKit 으로 반환한다.
	go handler(uint64(identifier))
}

//export nativeMessage
func nativeMessage(identifier C.ulonglong, message *C.char) {
	body := C.GoString(message)
	handler := receive
	if handler == nil {
		return
	}
	// 서비스는 주 스레드를 기다릴 수 있다. 호출하기 전에 WebKit 으로 반환한다.
	go handler(uint64(identifier), body)
}

func (implementation) CreateWebview(window unsafe.Pointer, options platform.WebviewOptions) (unsafe.Pointer, error) {
	receive = options.Receive
	committed = options.Committed
	script := C.CString(options.Script)
	defer C.free(unsafe.Pointer(script))
	handle := C.nativeWebviewCreate(window, C.ulonglong(options.Identifier), script,
		C.double(options.X), C.double(options.Y), C.double(options.Width), C.double(options.Height),
		C.bool(options.Hidden), C.bool(options.Transparent), C.bool(options.FillParent))
	if handle == nil {
		return nil, fmt.Errorf("cannot create a native webview in this window/WebKit")
	}
	return handle, nil
}

func (implementation) NavigateWebview(view unsafe.Pointer, url string) bool {
	target := C.CString(url)
	defer C.free(unsafe.Pointer(target))
	return bool(C.nativeWebviewNavigate(view, target))
}

func (implementation) SetWebviewBounds(view unsafe.Pointer, x, y, width, height float64) {
	C.nativeWebviewBounds(view, C.double(x), C.double(y), C.double(width), C.double(height))
}

func (implementation) SetWebviewHidden(view unsafe.Pointer, hidden bool) {
	C.nativeWebviewHidden(view, C.bool(hidden))
}

func (implementation) SetWebviewBackground(view unsafe.Pointer, enabled bool) {
	C.nativeWebviewBackground(view, C.bool(enabled))
}

func (implementation) EvaluateScript(view unsafe.Pointer, script string) {
	value := C.CString(script)
	defer C.free(unsafe.Pointer(value))
	C.nativeWebviewEval(view, value)
}

func (implementation) CloseWebview(view unsafe.Pointer) { C.nativeWebviewClose(view) }

// WebviewFrame 은 표면의 현재 영역을 반환한다. 호스트가 선언된 영역을 픽셀에 맞추므로
// 페이지가 보낸 영역과 다를 수 있고, 페이지는 그 차이를 전달받는다.
func (implementation) WebviewFrame(view unsafe.Pointer) platform.Rect {
	var out [4]C.double
	C.webviewGetFrame(view, &out[0])
	return platform.Rect{X: float64(out[0]), Y: float64(out[1]), W: float64(out[2]), H: float64(out[3])}
}

func (implementation) SetWebviewAlpha(view unsafe.Pointer, alpha float64) {
	C.webviewSetSurfaceAlpha(view, C.double(alpha))
}

func (implementation) SetSurfaceOverlays(view unsafe.Pointer, overlays []platform.DOMOverlay) {
	values := make([]C.double, 0, len(overlays)*5)
	for _, overlay := range overlays {
		visible := C.double(0)
		if overlay.Visible {
			visible = 1
		}
		values = append(values, C.double(overlay.Left), C.double(overlay.Top), C.double(overlay.Right),
			C.double(overlay.Bottom), visible)
	}
	var data *C.double
	if len(values) > 0 {
		data = &values[0]
	}
	C.webviewSetSurfaceOverlays(view, data, C.size_t(len(overlays)))
}

// SetWebviewResizing 은 표면의 연속 크기 변경을 시작하거나 끝낸다. 페이지는 방금 보낸
// 갱신이 마지막인지 알리고, 끝나지 않은 갱신은 연속 크기 변경이다.
func (implementation) SetWebviewResizing(view unsafe.Pointer, live bool) {
	if live {
		C.surfaceBeginLiveResize(view)
		return
	}
	C.surfaceEndLiveResize(view)
}

func (implementation) ConfigureModal(view unsafe.Pointer, title string, radius float64) {
	name := C.CString(title)
	defer C.free(unsafe.Pointer(name))
	C.modalViewConfigure(view, name, C.double(radius))
}

func (implementation) FocusModal(view unsafe.Pointer, take bool) {
	value := C.int(0)
	if take {
		value = 1
	}
	C.modalViewFocus(view, value)
}

func (implementation) AlignRect(window unsafe.Pointer, at platform.Rect) (platform.Rect, error) {
	var out [4]C.double
	C.modalAligned(window, C.double(at.X), C.double(at.Y), C.double(at.W), C.double(at.H), &out[0])
	return platform.Rect{X: float64(out[0]), Y: float64(out[1]), W: float64(out[2]), H: float64(out[3])}, nil
}
