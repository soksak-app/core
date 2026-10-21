//go:build darwin

package darwin

/*
#include <stdbool.h>
#include <stdint.h>
#include <stdlib.h>
#include "webview_geometry.h"
#include "window_facts.h"
extern void *sp_surface_create(void *mainWebview);
extern void sp_surface_close(void *surface);
extern void sp_surface_set_window_overlays(void *mainWebview, const double *rects, size_t count);
#import <Cocoa/Cocoa.h>
#import <WebKit/WebKit.h>

void *nativeWebviewCreate(void *window, unsigned long long identifier, const char *name, const char *script,
    double x, double y, double width, double height, bool hidden, bool transparent, bool fillParent);
bool nativeWebviewNavigate(void *view, const char *url);
void nativeWebviewBounds(void *view, double x, double y, double width, double height);
void nativeWebviewHidden(void *view, bool hidden);
void nativeWebviewBackground(void *view, bool enabled);
void nativeWebviewEval(void *view, const char *script);
void nativeWebviewClose(void *view);
bool nativeWindowConfigureMain(void *window, bool dark);
bool nativeWindowSetMainWebview(void *window);

extern void fileDropped(void *context, char *json);
extern void fileDropReleased(void *context);

static void fileDroppedBridge(void *context, const char *json) {
    fileDropped(context, (char *)json);
}

static void fileDropReleasedBridge(void *context) {
    fileDropReleased(context);
}

static bool windowFileDrop(void *main, uintptr_t context) {
    return sp_window_file_drop(main, fileDroppedBridge, fileDropReleasedBridge, (void *)context);
}

// Passes the start and the end of a continuous surface resize to the web view.
static void surfaceBeginLiveResize(void* handle) {
    [(WKWebView*)handle viewWillStartLiveResize];
}

static void surfaceEndLiveResize(void* handle) {
    [(WKWebView*)handle viewDidEndLiveResize];
}

// A modal is a WKWebView inside the main window. A layer clips the corners, and the position and the focus of the modal
// do not change the OS window hierarchy.
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

// Fits the modal region in page coordinates inward to the display pixel grid. Fitting outward would cover the border of the card,
// as with a surface.
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

// Sets the opacity of the view. The page dims a surface that lost focus.
*/
import "C"

import (
	"errors"
	"fmt"
	"runtime/cgo"
	"unsafe"

	"github.com/soksak-app/core/packages/host/wailsv3/src/platform"
	"github.com/soksak-app/core/packages/host/wailsv3/src/routine"
)

// dispatcher passes the commit and the messages of a web view to the receiver function. The receiver function is that of the last created web view, and the host
// passes the same function to all web views.
var dispatcher platform.Dispatcher

//export nativeCommitted
func nativeCommitted(identifier C.ulonglong) {
	dispatcher.Commit(uint64(identifier))
}

// terminated receives the end of the WebContent process of the web views; the host passes the same function to all web views, as the dispatcher does.
var terminated func(identifier uint64)

//export nativeTerminated
func nativeTerminated(identifier C.ulonglong) {
	if receiver := terminated; receiver != nil {
		routine.Go("webview-terminated", func() { receiver(uint64(identifier)) })
	}
}

//export nativeMessage
func nativeMessage(identifier C.ulonglong, message *C.char) {
	dispatcher.Message(uint64(identifier), C.GoString(message))
}

func (implementation) CreateWebview(window unsafe.Pointer, options platform.WebviewOptions) (unsafe.Pointer, error) {
	dispatcher.Handle(options.Receive, options.Committed)
	terminated = options.Terminated
	script := C.CString(options.Script)
	defer C.free(unsafe.Pointer(script))
	name := C.CString(options.Name)
	defer C.free(unsafe.Pointer(name))
	handle := C.nativeWebviewCreate(window, C.ulonglong(options.Identifier), name, script,
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

func (implementation) ConfigureMainWindow(window unsafe.Pointer, dark bool) error {
	if !bool(C.nativeWindowConfigureMain(window, C.bool(dark))) {
		return errors.New("the window has no main webview or the requested appearance is unavailable")
	}
	return nil
}

//export fileDropped
func fileDropped(context unsafe.Pointer, json *C.char) {
	dropped := cgo.Handle(uintptr(context)).Value().(func(string))
	dropped(C.GoString(json))
}

// Clears the handle when the drop view no longer uses the receiver.
//
//export fileDropReleased
func fileDropReleased(context unsafe.Pointer) {
	cgo.Handle(uintptr(context)).Delete()
}

func (implementation) FileDrop(main unsafe.Pointer, dropped func(json string)) error {
	handle := cgo.NewHandle(dropped)
	if !bool(C.windowFileDrop(main, C.uintptr_t(handle))) {
		handle.Delete()
		return fmt.Errorf("the main webview has no window composition for file drops")
	}
	return nil
}

func (implementation) SetMainWebview(window unsafe.Pointer) error {
	if bool(C.nativeWindowSetMainWebview(window)) {
		return nil
	}
	return fmt.Errorf("the main webview is not in the window hierarchy")
}

func (implementation) MainWebview(window unsafe.Pointer) (unsafe.Pointer, error) {
	main := C.sp_window_main_webview(window)
	if main == nil {
		return nil, fmt.Errorf("the window has no registered app DOM webview")
	}
	return main, nil
}

func (implementation) KillWebContentProcess(view unsafe.Pointer) error {
	if bool(C.sp_webview_kill_content_process(view)) {
		return nil
	}
	return fmt.Errorf("the WebContent process cannot be terminated")
}

func (implementation) CollectGarbage(view unsafe.Pointer) error {
	if bool(C.sp_webview_collect_garbage(view)) {
		return nil
	}
	return fmt.Errorf("the JavaScript garbage collection request is unavailable")
}

// WebviewFrame returns the current region of a surface. The host fits the declared region to pixels, so
// it can differ from the region that the page sent, and the page receives that difference.
func (implementation) WebviewFrame(view unsafe.Pointer) platform.Rect {
	var out [4]C.double
	C.webviewGetFrame(view, &out[0])
	return platform.Rect{X: float64(out[0]), Y: float64(out[1]), W: float64(out[2]), H: float64(out[3])}
}

func (implementation) CreateSurface(window unsafe.Pointer) (unsafe.Pointer, error) {
	main := C.sp_window_main_webview(window)
	if main == nil {
		return nil, fmt.Errorf("the window has no registered app DOM webview")
	}
	handle := C.sp_surface_create(main)
	if handle == nil {
		return nil, fmt.Errorf("cannot create SurfaceHost")
	}
	return handle, nil
}

func (implementation) CloseSurface(surface unsafe.Pointer) { C.sp_surface_close(surface) }
func (implementation) SetSurfaceBounds(surface unsafe.Pointer, x, y, width, height float64) {
	C.webviewSetFrame(surface, C.double(x), C.double(y), C.double(width), C.double(height))
}
func (implementation) SurfaceFrame(surface unsafe.Pointer) platform.Rect {
	return implementation{}.WebviewFrame(surface)
}
func (implementation) SetSurfaceHiddenHandle(surface unsafe.Pointer, hidden bool) {
	C.webviewSetSurfaceHidden(surface, C.bool(hidden))
}
func (implementation) SetSurfaceAlphaHandle(surface unsafe.Pointer, alpha float64) {
	C.webviewSetSurfaceAlpha(surface, C.double(alpha))
}
func (implementation) SetWindowOverlays(main unsafe.Pointer, overlays []platform.WindowOverlay) error {
	if main == nil {
		return fmt.Errorf("cannot set window overlays without the registered main webview")
	}
	packed := platform.VisibleWindowOverlayRects(overlays)
	values := make([]C.double, len(packed))
	for i, value := range packed {
		values[i] = C.double(value)
	}
	var data *C.double
	if len(values) > 0 {
		data = &values[0]
	}
	C.sp_surface_set_window_overlays(main, data, C.size_t(len(values)/4))
	return nil
}

func (implementation) SetWebviewAlpha(view unsafe.Pointer, alpha float64) {
	C.webviewSetSurfaceAlpha(view, C.double(alpha))
}

// surfaceOverlayValues returns the values of the native overlay call: five per overlay, the left, top, right and bottom insets and then 1 when visible or 0 when not.
func surfaceOverlayValues(overlays []platform.DOMOverlay) []float64 {
	values := make([]float64, 0, len(overlays)*5)
	for _, overlay := range overlays {
		visible := 0.0
		if overlay.Visible {
			visible = 1
		}
		values = append(values, overlay.Left, overlay.Top, overlay.Right, overlay.Bottom, visible)
	}
	return values
}

func (implementation) SetSurfaceOverlays(view unsafe.Pointer, overlays []platform.DOMOverlay) {
	floats := surfaceOverlayValues(overlays)
	values := make([]C.double, len(floats))
	for index, value := range floats {
		values[index] = C.double(value)
	}
	var data *C.double
	if len(values) > 0 {
		data = &values[0]
	}
	C.webviewSetSurfaceOverlays(view, data, C.size_t(len(overlays)))
}

// SetWebviewResizing starts or ends the continuous resize of a surface. The page tells whether the update it just sent
// is the last one, and an update that has not ended is a continuous resize.
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
