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

// Not under ARC, so the view is retained here and released in surfaceDestroy.
static void* surfaceCreate(void* nsWindow, const char* url, double x, double y, double w, double h) {
    NSWindow* window = (NSWindow*)nsWindow;
    NSView* parent = [window contentView];
    WKWebViewConfiguration* config = [[WKWebViewConfiguration alloc] init];
    WKWebView* view = [[WKWebView alloc] initWithFrame:NSMakeRect(0, 0, w, h) configuration:config];
    view.frame = NSMakeRect(x, [parent bounds].size.height - y - h, w, h);
    [parent addSubview:view positioned:NSWindowAbove relativeTo:nil];
    NSURL* target = [NSURL URLWithString:[NSString stringWithUTF8String:url]];
    [view loadRequest:[NSURLRequest requestWithURL:target]];
    [view retain];
    return (void*)view;
}

static void surfaceSetFrame(void* handle, double x, double y, double w, double h) {
    WKWebView* view = (WKWebView*)handle;
    NSView* parent = [view superview];
    if (parent == nil) return;
    view.frame = NSMakeRect(x, [parent bounds].size.height - y - h, w, h);
}

// Resizes about the top left, which is where the page put it.
static void surfaceResize(void* handle, double w, double h) {
    WKWebView* view = (WKWebView*)handle;
    NSRect frame = view.frame;
    view.frame = NSMakeRect(frame.origin.x, frame.origin.y + frame.size.height - h, w, h);
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

// The size of the area views are placed in. The page's own viewport is compared
// with this to find how far the page sits inside it, rather than assuming.
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

func newNativeView(window unsafe.Pointer, url string, x, y, w, h float64) *nativeView {
	target := C.CString(url)
	defer C.free(unsafe.Pointer(target))
	handle := C.surfaceCreate(window, target, C.double(x), C.double(y), C.double(w), C.double(h))
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

// contentSize reports the size of the area views are placed in.
func contentSize(window unsafe.Pointer) (float64, float64) {
	var w, h C.double
	C.surfaceContentSize(window, &w, &h)
	return float64(w), float64(h)
}
