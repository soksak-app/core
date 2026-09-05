//go:build darwin

// Webviews placed inside the window.
//
// Wails gives one webview per window and no API to add another, but it does
// hand over the window itself through NativeWindow(). A webview is a native
// view, so it can be added to that window's content view like any other, which
// is what the Tauri example gets from its own runtime.
//
// A frame arrives in the content view's coordinates, measured from the bottom
// left as AppKit does. The page measures from its top left; surfaces.go turns
// one into the other.
package main

/*
#cgo CFLAGS: -x objective-c -fmodules
#cgo LDFLAGS: -framework Cocoa -framework WebKit
#import <Cocoa/Cocoa.h>
#import <WebKit/WebKit.h>

// A frame arrives already in AppKit's coordinates. It is snapped to the backing
// store's pixel grid outward: the page reports fractional rects, and a frame
// snapped inward leaves the card's background showing along that edge.
//
// Outward means the view may cover up to half a pixel more than the page asked
// for. That half pixel is under the card's border, which the page draws and the
// surface does not reach.
static NSRect surfaceAligned(NSWindow* window, double x, double y, double w, double h) {
    return [window backingAlignedRect:NSMakeRect(x, y, w, h) options:NSAlignAllEdgesOutward];
}

// Not under ARC, so the view is retained here and released in surfaceDestroy.
static void* surfaceCreate(void* nsWindow, const char* url, double x, double y, double w, double h,
                           double red, double green, double blue) {
    NSWindow* window = (NSWindow*)nsWindow;
    NSView* parent = [window contentView];
    WKWebViewConfiguration* config = [[WKWebViewConfiguration alloc] init];
    WKWebView* view = [[WKWebView alloc] initWithFrame:NSMakeRect(0, 0, w, h) configuration:config];
    view.frame = surfaceAligned(window, x, y, w, h);
    // The colour the view shows where its page has not painted. Public since
    // macOS 12; without it that area is white.
    if (@available(macOS 12.0, *)) {
        view.underPageBackgroundColor =
            [NSColor colorWithSRGBRed:red green:green blue:blue alpha:1.0];
    }
    [view setWantsLayer:YES];
    view.layer.backgroundColor =
        [[NSColor colorWithSRGBRed:red green:green blue:blue alpha:1.0] CGColor];
    [parent addSubview:view positioned:NSWindowAbove relativeTo:nil];
    NSURL* target = [NSURL URLWithString:[NSString stringWithUTF8String:url]];
    [view loadRequest:[NSURLRequest requestWithURL:target]];
    [view retain];
    return (void*)view;
}

static void surfaceSetFrame(void* handle, double x, double y, double w, double h) {
    WKWebView* view = (WKWebView*)handle;
    NSWindow* window = [view window];
    if (window == nil) return;
    view.frame = surfaceAligned(window, x, y, w, h);
}

// Resizes about the top left, which is where the page put it.
static void surfaceResize(void* handle, double w, double h) {
    WKWebView* view = (WKWebView*)handle;
    NSRect frame = view.frame;
    view.frame = NSMakeRect(frame.origin.x, frame.origin.y + frame.size.height - h, w, h);
}

// How solid the view is. A surface that lost focus can be asked to stand back.
static void surfaceSetAlpha(void* handle, double alpha) {
    WKWebView* view = (WKWebView*)handle;
    [view setAlphaValue:alpha];
}

static void surfaceSetHidden(void* handle, int hidden) {
    WKWebView* view = (WKWebView*)handle;
    [view setHidden:hidden ? YES : NO];
}

// Raises the view above its siblings. A view added later sits above the ones
// before it, so a modal has to be lifted after a surface has been added.
static void surfaceRaise(void* handle) {
    WKWebView* view = (WKWebView*)handle;
    NSView* parent = [view superview];
    if (parent == nil) return;
    [parent addSubview:view positioned:NSWindowAbove relativeTo:nil];
}

// Clips the view to a rounded rectangle. The corners are then not drawn, so
// whatever is behind them shows through: no transparency is involved.
static void surfaceSetCornerRadius(void* handle, double radius) {
    WKWebView* view = (WKWebView*)handle;
    [view setWantsLayer:YES];
    view.layer.cornerRadius = radius;
    view.layer.masksToBounds = YES;
}

// Reports one view a press is for. Returns non-zero once the view is a surface,
// and the walk up from the view that was hit stops there.
extern int surfaceHit(void* view);

// A surface is a native view, so a press on it never reaches the page. One
// monitor on the app sees every press, and AppKit is asked which view the press
// is for: the answer is a view, not a point, so nothing has to be converted and
// nothing can disagree with where the page thinks a surface stands.
//
// The monitor returns the event unchanged and the view still receives it.
static void surfaceWatchMouse(void* nsWindow) {
    NSWindow* window = (NSWindow*)nsWindow;
    [NSEvent addLocalMonitorForEventsMatchingMask:NSEventMaskLeftMouseDown
                                          handler:^NSEvent*(NSEvent* event) {
        if ([event window] == window) {
            NSView* content = [window contentView];
            NSView* view = [content hitTest:[event locationInWindow]];
            while (view != nil && view != content) {
                if (surfaceHit((void*)view)) {
                    break;
                }
                view = [view superview];
            }
        }
        return event;
    }];
}

static void surfaceDestroy(void* handle) {
    WKWebView* view = (WKWebView*)handle;
    [view removeFromSuperview];
    [view release];
}
*/
import "C"

import "unsafe"

// nativeView is one webview living inside the window.
type nativeView struct{ handle unsafe.Pointer }

func newNativeView(window unsafe.Pointer, url string, x, y, w, h float64, background [3]float64) *nativeView {
	target := C.CString(url)
	defer C.free(unsafe.Pointer(target))
	handle := C.surfaceCreate(window, target, C.double(x), C.double(y), C.double(w), C.double(h),
		C.double(background[0]), C.double(background[1]), C.double(background[2]))
	if handle == nil {
		return nil
	}
	return &nativeView{handle: handle}
}

func (v *nativeView) setFrame(x, y, w, h float64) {
	C.surfaceSetFrame(v.handle, C.double(x), C.double(y), C.double(w), C.double(h))
}

func (v *nativeView) resize(w, h float64) {
	C.surfaceResize(v.handle, C.double(w), C.double(h))
}

func (v *nativeView) setAlpha(alpha float64) {
	C.surfaceSetAlpha(v.handle, C.double(alpha))
}

func (v *nativeView) setHidden(hidden bool) {
	flag := C.int(0)
	if hidden {
		flag = 1
	}
	C.surfaceSetHidden(v.handle, flag)
}

func (v *nativeView) raise() { C.surfaceRaise(v.handle) }

func (v *nativeView) setCornerRadius(radius float64) {
	C.surfaceSetCornerRadius(v.handle, C.double(radius))
}

func (v *nativeView) destroy() { C.surfaceDestroy(v.handle) }

// id names this view among the ones a press walks through.
func (v *nativeView) id() uintptr { return uintptr(v.handle) }

// watchMouse starts the monitor. Called once, when the first surface appears.
func watchMouse(window unsafe.Pointer) { C.surfaceWatchMouse(window) }
