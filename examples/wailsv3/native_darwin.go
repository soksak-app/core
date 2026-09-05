//go:build darwin

// Webviews placed inside the window.
//
// Wails gives one webview per window and no API to add another, but it does
// hand over the window itself through NativeWindow(). A webview is a native
// view, so it can be added to that window's content view like any other, which
// is what the Tauri example gets from its own runtime.
//
// Views are placed in the content view's coordinates. AppKit measures from the
// bottom left, so a frame given from the top left is flipped here.
package main

/*
#cgo CFLAGS: -x objective-c -fmodules
#cgo LDFLAGS: -framework Cocoa -framework WebKit
#import <Cocoa/Cocoa.h>
#import <WebKit/WebKit.h>

// The view the page itself lives in. It is the first thing in the content view;
// everything this app adds goes above it.
static NSView* surfacePageView(NSWindow* window) {
    NSArray<NSView*>* subviews = [[window contentView] subviews];
    return [subviews count] == 0 ? nil : [subviews objectAtIndex:0];
}

// One frame, from the content view's top left into the frame AppKit wants.
static NSRect surfaceInContent(NSWindow* window, double x, double y, double w, double h) {
    NSView* content = [window contentView];
    return NSMakeRect(x, [content bounds].size.height - y - h, w, h);
}

// Not under ARC, so the view is retained here and released in surfaceDestroy.
static void* surfaceCreate(void* nsWindow, const char* url, double x, double y, double w, double h,
                           double red, double green, double blue) {
    NSWindow* window = (NSWindow*)nsWindow;
    NSView* parent = [window contentView];
    WKWebViewConfiguration* config = [[WKWebViewConfiguration alloc] init];
    WKWebView* view = [[WKWebView alloc] initWithFrame:NSMakeRect(0, 0, w, h) configuration:config];
    view.frame = surfaceInContent(window, x, y, w, h);
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
    view.frame = surfaceInContent(window, x, y, w, h);
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

// Reports where the mouse went down, in the page's own coordinates — the same
// ones the frames are given in.
//
// A surface is a native view, so a press on it never reaches the page. One
// monitor on the app sees every press, wherever it landed, including on a view
// this app did not make and cannot reach into.
extern void surfaceMouseDown(double x, double y);

static void surfaceWatchMouse(void* nsWindow) {
    NSWindow* window = (NSWindow*)nsWindow;
    [NSEvent addLocalMonitorForEventsMatchingMask:NSEventMaskLeftMouseDown
                                          handler:^NSEvent*(NSEvent* event) {
        if ([event window] == window) {
            NSView* content = [window contentView];
            NSPoint p = [content convertPoint:[event locationInWindow] fromView:nil];
            surfaceMouseDown(p.x, [content bounds].size.height - p.y);
        }
        return event;
    }];
}

// The size of the area views are placed in, so the page's offset inside it can
// be worked out.
static void surfaceContentSize(void* nsWindow, double* w, double* h) {
    NSWindow* window = (NSWindow*)nsWindow;
    NSRect bounds = [[window contentView] bounds];
    *w = bounds.size.width;
    *h = bounds.size.height;
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

// watchMouse starts the monitor. Called once, when the first surface appears.
func watchMouse(window unsafe.Pointer) { C.surfaceWatchMouse(window) }

// contentSize reports the size of the area views are placed in.
func contentSize(window unsafe.Pointer) (float64, float64) {
	var w, h C.double
	C.surfaceContentSize(window, &w, &h)
	return float64(w), float64(h)
}
