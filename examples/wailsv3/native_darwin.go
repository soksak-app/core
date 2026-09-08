//go:build darwin

// macOS 호스트의 도형, 입력과 창 버튼을 처리한다.
// 웹뷰 생성은 webview_darwin.m, 좌표 변환은 공통 webview_geometry_darwin.m에서 처리한다.
package main

/*
#cgo CFLAGS: -x objective-c -fmodules
#cgo LDFLAGS: -framework Cocoa -framework WebKit
#include "window_controls_darwin.h"
#include "webview_geometry_darwin.h"
#include <stdlib.h>
#import <Cocoa/Cocoa.h>
#import <WebKit/WebKit.h>

// A frame arrives already in AppKit's coordinates. It is snapped to the backing
// store's pixel grid inward, so the view never covers more than the rect the page
// declared.
//
// Snapping outward would be the other choice, and it is wrong here. The page's
// lines lie in the passage between two cards, and when that passage is one line
// wide two surfaces sit half a pixel away from it on either side. Grown outward,
// the two together cover the line and the page's focus mark disappears.
//
// Inward leaves up to half a pixel of the card's background along each edge. The
// card's background is what is behind the surface anyway.
static NSRect surfaceAligned(NSWindow* window, double x, double y, double w, double h) {
    return [window backingAlignedRect:NSMakeRect(x, y, w, h) options:NSAlignAllEdgesInward];
}

// 연속적인 표면 크기 변경의 시작과 종료를 웹뷰에 전달한다.
static void surfaceBeginLiveResize(void* handle) {
    [(WKWebView*)handle viewWillStartLiveResize];
}

static void surfaceEndLiveResize(void* handle) {
    [(WKWebView*)handle viewDidEndLiveResize];
}

// Moves a shape's view, on the display's pixels so its edges stay crisp. The rect
// is in the page's coordinates, measured from the content view's top left, which
// is what the page declares.
static void shapeSetFrame(void* handle, double x, double y, double w, double h) {
    NSView* view = (NSView*)handle;
    NSWindow* window = [view window];
    if (window == nil || [window contentView] == nil) return;
    double up = [window contentView].bounds.size.height - y - h;
    view.frame = surfaceAligned(window, x, up, w, h);
}

// A modal is a WKWebView in the main window. Its layer clips its corners;
// neither its geometry nor its focus changes the OS window hierarchy.
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

// Snaps a modal's rect, given in the page's coordinates, inward to the display's
// pixel grid. Snapping outward would cover the card's own border, as it would for
// a surface.
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

// Sets the view's alpha. The page dims a surface that has lost focus.
static void surfaceSetAlpha(void* handle, double alpha) {
    WKWebView* view = (WKWebView*)handle;
    [view setAlphaValue:alpha];
}

// Raises a shape above its siblings.
static void surfaceRaise(void* handle) {
    WKWebView* view = (WKWebView*)handle;
    NSView* parent = [view superview];
    if (parent == nil) return;
    [parent addSubview:view positioned:NSWindowAbove relativeTo:nil];
}

// Reports whether one view is a surface. Returns non-zero for a surface, and the
// walk up from the hit view stops there.
extern int surfaceHit(uintptr_t owner, void* view);

// Reports one step of a left-button drag, in the page's coordinates.
// phase is 0 for a press, 1 for a move, 2 for a release.
extern void surfacePoint(uintptr_t owner, int phase, double x, double y);

// Walks up from a view to the content view, reporting the first surface. Returns
// whether one was found, which is also whether the input began on this app's own
// views rather than on the page.
static int surfaceWalk(uintptr_t owner, NSView* view, NSView* content) {
    while (view != nil && view != content) {
        if (surfaceHit(owner, (void*)view)) {
            return 1;
        }
        view = [view superview];
    }
    return 0;
}

// Whether the button went down on one of this app's views. A drag that began on
// the page is the page's own and needs nothing from here; forwarding it would put
// one message per pointer move on the same thread that has to redraw the plane.


// A surface is a native view, so input on it never reaches the page. One monitor
// on the app receives every press, every drag and every key, and reports two
// things: which view the input was for, and where it was.
//
// A press is answered by hitTest:. A key goes to the window's first responder,
// which is what a page that focuses itself becomes: google.com focuses its search
// field on load, and without this the page's model still names the surface that
// was pressed last. Neither converts a coordinate, so neither can disagree with
// the page's frame.
//
// The point is converted, and it has to be. A divider's grab area is wider than
// the passage between two cards, so when the passage is one line wide the whole
// area lies over the surfaces and no press in it reaches the page. The page
// decides what the point means; this reports it in the page's own coordinates,
// which the content view's height gives because the page's view fills it.
//
// The monitor returns the event unchanged and the view still receives it.
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

// A plain layer-backed view, used for the shapes the page draws over the
// surfaces. An NSView with a layer takes a colour with an alpha channel and
// composites over what is behind it, which a WKWebView cannot do: WebKit paints
// its own opaque background and the key that turns that off is private.
static void* shapeCreate(void* nsWindow, double x, double y, double w, double h) {
    NSWindow* window = (NSWindow*)nsWindow;
    if (window == nil || [window contentView] == nil) return NULL;
    double up = [window contentView].bounds.size.height - y - h;
    NSView* view = [[NSView alloc] initWithFrame:surfaceAligned(window, x, up, w, h)];
    [view setWantsLayer:YES];
    [[window contentView] addSubview:view positioned:NSWindowAbove relativeTo:nil];
    return (void*)view;
}

static void shapeSetStyle(void* handle, double radius, double lineWidth,
                          double fr, double fg, double fb, double fa,
                          double lr, double lg, double lb, double la) {
    NSView* view = (NSView*)handle;
    view.layer.cornerRadius = radius;
    view.layer.borderWidth = lineWidth;
    view.layer.backgroundColor =
        [[NSColor colorWithSRGBRed:fr green:fg blue:fb alpha:fa] CGColor];
    view.layer.borderColor =
        [[NSColor colorWithSRGBRed:lr green:lg blue:lb alpha:la] CGColor];
}

// Removes a shape's view and releases the reference alloc returned. The
// superview holds one of its own until removeFromSuperview.
static void shapeDestroy(void* handle) {
    NSView* view = (NSView*)handle;
    [view removeFromSuperview];
    [view release];
}
*/
import "C"

import (
	"runtime/cgo"
	"unsafe"
)

// surfaceFrame reports where a surface is now, in the page's coordinates. The
// host aligns a declared rect to the display's pixels, so this is not the rect
// the page sent and the page is told the difference.
func surfaceFrame(view unsafe.Pointer) Rect {
	var out [4]C.double
	C.webviewGetFrame(view, &out[0])
	return Rect{X: float64(out[0]), Y: float64(out[1]), W: float64(out[2]), H: float64(out[3])}
}

func windowControls(window unsafe.Pointer) Rect {
	var out [4]C.double
	C.windowControls(window, &out[0])
	return Rect{X: float64(out[0]), Y: float64(out[1]), W: float64(out[2]), H: float64(out[3])}
}

func windowPlaceControls(window unsafe.Pointer, x, y float64) {
	C.windowPlaceControls(window, C.double(x), C.double(y))
}

// modalViewConfigure names and clips a child webview.
func modalViewConfigure(view unsafe.Pointer, title string, radius float64) {
	name := C.CString(title)
	defer C.free(unsafe.Pointer(name))
	C.modalViewConfigure(view, name, C.double(radius))
}

// modalViewFocus transfers focus between the overlay and main webviews.
func modalViewFocus(view unsafe.Pointer, take bool) {
	value := C.int(0)
	if take {
		value = 1
	}
	C.modalViewFocus(view, value)
}

// modalAligned snaps a modal's rect to the display's pixels, in the page's
// coordinates.
func modalAligned(parent unsafe.Pointer, at Rect) Rect {
	var out [4]C.double
	C.modalAligned(parent, C.double(at.X), C.double(at.Y), C.double(max1(at.W)),
		C.double(max1(at.H)), &out[0])
	return Rect{X: float64(out[0]), Y: float64(out[1]), W: float64(out[2]), H: float64(out[3])}
}

// surfaceAlpha sets how solid a surface is drawn. The page dims one that lost
// focus.
func surfaceAlpha(view unsafe.Pointer, alpha float64) {
	C.surfaceSetAlpha(view, C.double(alpha))
}

// surfaceResizing brackets a run of resizes on a surface. The page reports
// whether the update it just sent is the last one, and a run that is not over is
// a live resize.
func surfaceResizing(view unsafe.Pointer, live bool) {
	if live {
		C.surfaceBeginLiveResize(view)
		return
	}
	C.surfaceEndLiveResize(view)
}

var mouseOwners = map[uintptr]cgo.Handle{}

func watchMouse(window unsafe.Pointer, owner *Surfaces) uintptr {
	handle := cgo.NewHandle(owner)
	monitor := uintptr(C.surfaceWatchMouse(window, C.uintptr_t(handle)))
	mouseOwners[monitor] = handle
	return monitor
}
func unwatchMouse(monitor uintptr) {
	if handle, ok := mouseOwners[monitor]; ok {
		C.surfaceUnwatchMouse(C.uintptr_t(monitor))
		handle.Delete()
		delete(mouseOwners, monitor)
	}
}

// nativeShape is a layer-backed view drawn above the surfaces.
type nativeShape struct{ handle unsafe.Pointer }

func newNativeShape(window unsafe.Pointer, x, y, w, h float64) *nativeShape {
	handle := C.shapeCreate(window, C.double(x), C.double(y), C.double(w), C.double(h))
	if handle == nil {
		return nil
	}
	return &nativeShape{handle: handle}
}

func (v *nativeShape) setFrame(x, y, w, h float64) {
	C.shapeSetFrame(v.handle, C.double(x), C.double(y), C.double(w), C.double(h))
}

func (v *nativeShape) setStyle(radius, lineWidth float64, fill, line [4]float64) {
	C.shapeSetStyle(v.handle, C.double(radius), C.double(lineWidth),
		C.double(fill[0]), C.double(fill[1]), C.double(fill[2]), C.double(fill[3]),
		C.double(line[0]), C.double(line[1]), C.double(line[2]), C.double(line[3]))
}

func (v *nativeShape) raise() { C.surfaceRaise(v.handle) }

func (v *nativeShape) destroy() { C.shapeDestroy(v.handle) }
