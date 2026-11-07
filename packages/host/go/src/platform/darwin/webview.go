//go:build darwin

package darwin

/*
#include <stdbool.h>
#include <stdint.h>
#include <stdlib.h>
#include "webview_geometry.h"
#include "window_facts.h"
#include "main_thread.h"
extern void *sp_surface_create(void *view);
extern void sp_surface_close(void *surface);
extern void sp_surface_set_window_overlays(void *mainWebview, const double *rects, size_t count);
#import <Cocoa/Cocoa.h>
#import <WebKit/WebKit.h>

// The native calls of this file run on the main thread (main_thread.h).
static void *main_sp_window_main_webview(uintptr_t window) { return ON_MAIN(void *, sp_window_main_webview((void *)window)); }
static bool main_sp_webview_collect_garbage(void *view) { return ON_MAIN(bool, sp_webview_collect_garbage(view)); }
static void main_webviewGetFrame(void *view, double *out) { hostRunOnMain(^{ webviewGetFrame(view, out); }); }
static void main_view_retain(void *view) { hostRunOnMain(^{ CFRetain(view); }); }
static void main_view_release(void *view) { hostRunOnMain(^{ CFRelease(view); }); }
static void *main_sp_window_native_view(uintptr_t window) { return ON_MAIN(void *, sp_window_native_view((void *)window)); }
static void *main_sp_surface_create(uintptr_t window) { return ON_MAIN(void *, sp_surface_create(sp_window_composition((void *)window))); }
static void main_sp_surface_close(void *surface) { hostRunOnMain(^{ sp_surface_close(surface); }); }
static void main_webviewSetFrame(void *view, double x, double y, double width, double height) {
    hostRunOnMain(^{ webviewSetFrame(view, x, y, width, height); });
}
static void main_sp_surface_focus(void *surface) { hostRunOnMain(^{ sp_surface_focus(surface); }); }
static void main_sp_surface_focus_for_region(void *surface) { hostRunOnMain(^{ sp_surface_focus_for_region(surface); }); }
static void main_sp_window_focus_workbench(uintptr_t window) { hostRunOnMain(^{ sp_window_focus_workbench((void *)window); }); }
static void main_sp_window_keyboard_hold(uintptr_t window) { hostRunOnMain(^{ sp_window_keyboard_hold((void *)window); }); }
static void main_sp_window_keyboard_decided(uintptr_t window) { hostRunOnMain(^{ sp_window_keyboard_decided((void *)window); }); }
static void main_sp_window_modal_hold(uintptr_t window) { hostRunOnMain(^{ sp_window_modal_hold((void *)window); }); }
static void main_sp_window_modal_hold_end(uintptr_t window) { hostRunOnMain(^{ sp_window_modal_hold_end((void *)window); }); }
static void main_webviewSetSurfaceHidden(void *view, bool hidden) { hostRunOnMain(^{ webviewSetSurfaceHidden(view, hidden); }); }
static void main_webviewSetSurfaceAlpha(void *view, double alpha) { hostRunOnMain(^{ webviewSetSurfaceAlpha(view, alpha); }); }
static void main_sp_surface_set_window_overlays(void *main, const double *rects, size_t count) {
    hostRunOnMain(^{ sp_surface_set_window_overlays(main, rects, count); });
}
static void main_webviewSetSurfaceOverlays(void *view, const double *values, size_t count) {
    hostRunOnMain(^{ webviewSetSurfaceOverlays(view, values, count); });
}

void *nativeWebviewCreate(uintptr_t window, unsigned long long identifier, const char *name, const char *script,
    double x, double y, double width, double height, bool hidden, bool transparent);
bool nativeWebviewNavigate(void *view, const char *url);
void nativeWebviewBounds(void *view, double x, double y, double width, double height);
void nativeWebviewHidden(void *view, bool hidden);
void nativeWebviewBackground(void *view, bool enabled);
void nativeWebviewEval(void *view, const char *script);
void nativeWebviewClose(void *view);
bool nativeWindowConfigureMain(uintptr_t window, bool dark);
bool nativeWindowSetMainWebview(uintptr_t window);

extern void goFileDropped(void *context, char *json);
extern void goFileDropReleased(void *context);

static void fileDroppedBridge(void *context, const char *json) {
    hostRunOnWorker(^{ goFileDropped(context, (char *)json); });
}

static void fileDropReleasedBridge(void *context) {
    hostRunOnWorker(^{ goFileDropReleased(context); });
}

static bool windowFileDrop(void *main, uintptr_t context) {
    return ON_MAIN(bool, sp_window_file_drop(main, fileDroppedBridge, fileDropReleasedBridge, (void *)context));
}

// A modal is a WKWebView inside the main window. A layer clips the corners, and the position and the focus of the modal
// do not change the OS window hierarchy.
static void modalViewConfigureOnMain(void* handle, const char* title, double radius) {
    NSView* view = (NSView*)handle;
    [view setWantsLayer:YES];
    view.layer.cornerRadius = radius;
    view.layer.masksToBounds = YES;
    if (title != NULL) [view setAccessibilityLabel:[NSString stringWithUTF8String:title]];
}

static void modalViewFocusOnMain(void* handle, int take) {
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
static void modalAlignedOnMain(void* parentWindow, double x, double y, double w, double h,
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

static void modalViewConfigure(void* handle, const char* title, double radius) {
    hostRunOnMain(^{ modalViewConfigureOnMain(handle, title, radius); });
}
static void modalViewFocus(void* handle, int take) {
    hostRunOnMain(^{ modalViewFocusOnMain(handle, take); });
}
static void modalAligned(uintptr_t parentWindow, double x, double y, double w, double h, double* out) {
    hostRunOnMain(^{ modalAlignedOnMain((void *)parentWindow, x, y, w, h, out); });
}
*/
import "C"

import (
	"errors"
	"fmt"
	"runtime/cgo"
	"unsafe"

	"github.com/soksak-app/core/packages/host/go/src/platform"
	"github.com/soksak-app/core/packages/host/go/src/routine"
)

// dispatcher passes the commit and the messages of a web view to the receiver function. The receiver function is that of the last created web view, and the host
// passes the same function to all web views.
var dispatcher platform.Dispatcher

//export goNativeCommitted
func goNativeCommitted(identifier C.ulonglong) {
	dispatcher.Commit(uint64(identifier))
}

// terminated receives the end of the WebContent process of the web views; the host passes the same function to all web views, as the dispatcher does.
var terminated func(identifier uint64)

//export goNativeTerminated
func goNativeTerminated(identifier C.ulonglong) {
	if receiver := terminated; receiver != nil {
		routine.Go("webview-terminated", func() { receiver(uint64(identifier)) })
	}
}

//export goNativeMessage
func goNativeMessage(identifier C.ulonglong, message *C.char) {
	dispatcher.Message(uint64(identifier), C.GoString(message))
}

func (implementation) CreateWebview(window platform.Window, options platform.WebviewOptions) (unsafe.Pointer, error) {
	dispatcher.Handle(options.Receive, options.Committed)
	terminated = options.Terminated
	script := C.CString(options.Script)
	defer C.free(unsafe.Pointer(script))
	name := C.CString(options.Name)
	defer C.free(unsafe.Pointer(name))
	handle := C.nativeWebviewCreate(C.uintptr_t(window), C.ulonglong(options.Identifier), name, script,
		C.double(options.X), C.double(options.Y), C.double(options.Width), C.double(options.Height),
		C.bool(options.Hidden), C.bool(options.Transparent))
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

func (implementation) ConfigureMainWindow(window platform.Window, dark bool) error {
	if !bool(C.nativeWindowConfigureMain(C.uintptr_t(window), C.bool(dark))) {
		return errors.New("the window has no main webview or the requested appearance is unavailable")
	}
	return nil
}

//export goFileDropped
func goFileDropped(context unsafe.Pointer, json *C.char) {
	dropped := cgo.Handle(uintptr(context)).Value().(func(string))
	dropped(C.GoString(json))
}

// Clears the handle when the drop view no longer uses the receiver.
//
//export goFileDropReleased
func goFileDropReleased(context unsafe.Pointer) {
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

func (implementation) SetMainWebview(window platform.Window) error {
	if bool(C.nativeWindowSetMainWebview(C.uintptr_t(window))) {
		return nil
	}
	return fmt.Errorf("the main webview is not in the window hierarchy")
}

func (implementation) MainWebview(window platform.Window) (unsafe.Pointer, error) {
	main := C.main_sp_window_main_webview(C.uintptr_t(window))
	if main == nil {
		return nil, fmt.Errorf("the window has no registered app DOM webview")
	}
	return main, nil
}

func (implementation) CollectGarbage(view unsafe.Pointer) error {
	if bool(C.main_sp_webview_collect_garbage(view)) {
		return nil
	}
	return fmt.Errorf("the JavaScript garbage collection request is unavailable")
}

func (implementation) NativeView(window platform.Window) unsafe.Pointer {
	return C.main_sp_window_native_view(C.uintptr_t(window))
}

func (implementation) RetainView(view unsafe.Pointer) { C.main_view_retain(view) }

func (implementation) ReleaseView(view unsafe.Pointer) { C.main_view_release(view) }

func (implementation) CreateSurface(window platform.Window) (unsafe.Pointer, error) {
	handle := C.main_sp_surface_create(C.uintptr_t(window))
	if handle == nil {
		return nil, fmt.Errorf("cannot create SurfaceHost")
	}
	return handle, nil
}

func (implementation) CloseSurface(surface unsafe.Pointer) { C.main_sp_surface_close(surface) }
func (implementation) SetSurfaceBounds(surface unsafe.Pointer, x, y, width, height float64) {
	C.main_webviewSetFrame(surface, C.double(x), C.double(y), C.double(width), C.double(height))
}

// SurfaceFrame returns the current region of a surface. The host fits the declared region to pixels, so
// it can differ from the region that the page sent, and the page receives that difference.
func (implementation) SurfaceFrame(surface unsafe.Pointer) platform.Rect {
	var out [4]C.double
	C.main_webviewGetFrame(surface, &out[0])
	return platform.Rect{X: float64(out[0]), Y: float64(out[1]), W: float64(out[2]), H: float64(out[3])}
}
func (implementation) SetSurfaceHiddenHandle(surface unsafe.Pointer, hidden bool) {
	C.main_webviewSetSurfaceHidden(surface, C.bool(hidden))
}
func (implementation) FocusSurface(surface unsafe.Pointer) { C.main_sp_surface_focus(surface) }
func (implementation) FocusSurfaceForRegion(surface unsafe.Pointer) {
	C.main_sp_surface_focus_for_region(surface)
}
func (implementation) FocusWorkbench(window platform.Window) {
	C.main_sp_window_focus_workbench(C.uintptr_t(window))
}
func (implementation) KeyboardHold(window platform.Window) {
	C.main_sp_window_keyboard_hold(C.uintptr_t(window))
}
func (implementation) KeyboardDecided(window platform.Window) {
	C.main_sp_window_keyboard_decided(C.uintptr_t(window))
}
func (implementation) ModalHold(window platform.Window) {
	C.main_sp_window_modal_hold(C.uintptr_t(window))
}
func (implementation) ModalHoldEnd(window platform.Window) {
	C.main_sp_window_modal_hold_end(C.uintptr_t(window))
}
func (implementation) SetSurfaceAlphaHandle(surface unsafe.Pointer, alpha float64) {
	C.main_webviewSetSurfaceAlpha(surface, C.double(alpha))
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
	C.main_sp_surface_set_window_overlays(main, data, C.size_t(len(values)/4))
	return nil
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
	C.main_webviewSetSurfaceOverlays(view, data, C.size_t(len(overlays)))
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

func (implementation) AlignRect(window platform.Window, at platform.Rect) (platform.Rect, error) {
	var out [4]C.double
	C.modalAligned(C.uintptr_t(window), C.double(at.X), C.double(at.Y), C.double(at.W), C.double(at.H), &out[0])
	return platform.Rect{X: float64(out[0]), Y: float64(out[1]), W: float64(out[2]), H: float64(out[3])}, nil
}
