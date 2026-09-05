//go:build darwin

// Webviews placed inside the window.
//
// Wails creates one webview per window and has no API for adding another, but
// NativeWindow() exposes the window. A webview is a native view, so it is added
// to that window's content view directly. The Tauri runtime provides the same
// through its own API.
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
// Outward means the view covers up to half a pixel more than the declared rect.
// That half pixel falls under the card's border, which the page draws.
static NSRect surfaceAligned(NSWindow* window, double x, double y, double w, double h) {
    return [window backingAlignedRect:NSMakeRect(x, y, w, h) options:NSAlignAllEdgesOutward];
}

// Not under ARC, so the view is retained here and released in surfaceDestroy.
static void* surfaceCreate(void* nsWindow, const char* url, double x, double y, double w, double h,
                           double red, double green, double blue, double alpha) {
    NSWindow* window = (NSWindow*)nsWindow;
    NSView* parent = [window contentView];
    WKWebViewConfiguration* config = [[WKWebViewConfiguration alloc] init];
    WKWebView* view = [[WKWebView alloc] initWithFrame:NSMakeRect(0, 0, w, h) configuration:config];
    view.frame = surfaceAligned(window, x, y, w, h);
    // The colour the view shows where its page has not painted. Public since
    // macOS 12; without it that area is white.
    if (@available(macOS 12.0, *)) {
        view.underPageBackgroundColor =
            [NSColor colorWithSRGBRed:red green:green blue:blue alpha:alpha];
    }
    [view setWantsLayer:YES];
    view.layer.backgroundColor =
        [[NSColor colorWithSRGBRed:red green:green blue:blue alpha:alpha] CGColor];
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

// Resizes about the top left, which is the origin the page declared.
static void surfaceResize(void* handle, double w, double h) {
    WKWebView* view = (WKWebView*)handle;
    NSRect frame = view.frame;
    view.frame = NSMakeRect(frame.origin.x, frame.origin.y + frame.size.height - h, w, h);
}

// Sets the view's alpha. The page dims a surface that has lost focus.
static void surfaceSetAlpha(void* handle, double alpha) {
    WKWebView* view = (WKWebView*)handle;
    [view setAlphaValue:alpha];
}

static void surfaceSetHidden(void* handle, int hidden) {
    WKWebView* view = (WKWebView*)handle;
    [view setHidden:hidden ? YES : NO];
}

// Raises the view above its siblings. A view added later is above the earlier
// ones, so a modal is raised again after a surface is added.
static void surfaceRaise(void* handle) {
    WKWebView* view = (WKWebView*)handle;
    NSView* parent = [view superview];
    if (parent == nil) return;
    [parent addSubview:view positioned:NSWindowAbove relativeTo:nil];
}

// Clips the view to a rounded rectangle. The corners are not drawn, so what is
// behind them shows through. No transparency is applied.
static void surfaceSetCornerRadius(void* handle, double radius) {
    WKWebView* view = (WKWebView*)handle;
    [view setWantsLayer:YES];
    view.layer.cornerRadius = radius;
    view.layer.masksToBounds = YES;
}

// Reports whether one view is a surface. Returns non-zero for a surface, and the
// walk up from the hit view stops there.
extern int surfaceHit(void* view);

// A surface is a native view, so a press on it never reaches the page. One
// monitor on the app receives every press and AppKit reports which view it hit.
// The result is a view rather than a point, so no coordinate is converted and
// none can disagree with the page's frame.
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

// A plain layer-backed view, used for the shapes the page draws over the
// surfaces. An NSView with a layer takes a colour with an alpha channel and
// composites over what is behind it, which a WKWebView cannot do: WebKit paints
// its own opaque background and the key that turns that off is private.
static void* shapeCreate(void* nsWindow, double x, double y, double w, double h) {
    NSWindow* window = (NSWindow*)nsWindow;
    NSView* view = [[NSView alloc] initWithFrame:surfaceAligned(window, x, y, w, h)];
    [view setWantsLayer:YES];
    [[window contentView] addSubview:view positioned:NSWindowAbove relativeTo:nil];
    [view retain];
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

static void surfaceDestroy(void* handle) {
    WKWebView* view = (WKWebView*)handle;
    [view removeFromSuperview];
    [view release];
}
*/
import "C"

import "unsafe"

// nativeView is one webview inside the window.
type nativeView struct{ handle unsafe.Pointer }

func newNativeView(window unsafe.Pointer, url string, x, y, w, h float64, background [4]float64) *nativeView {
	target := C.CString(url)
	defer C.free(unsafe.Pointer(target))
	handle := C.surfaceCreate(window, target, C.double(x), C.double(y), C.double(w), C.double(h),
		C.double(background[0]), C.double(background[1]), C.double(background[2]),
		C.double(background[3]))
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

// id identifies this view among the ones a press passes through.
func (v *nativeView) id() uintptr { return uintptr(v.handle) }

// watchMouse starts the monitor. Called once, when the first surface appears.
func watchMouse(window unsafe.Pointer) { C.surfaceWatchMouse(window) }

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
	C.surfaceSetFrame(v.handle, C.double(x), C.double(y), C.double(w), C.double(h))
}

func (v *nativeShape) setStyle(radius, lineWidth float64, fill, line [4]float64) {
	C.shapeSetStyle(v.handle, C.double(radius), C.double(lineWidth),
		C.double(fill[0]), C.double(fill[1]), C.double(fill[2]), C.double(fill[3]),
		C.double(line[0]), C.double(line[1]), C.double(line[2]), C.double(line[3]))
}

func (v *nativeShape) raise() { C.surfaceRaise(v.handle) }

func (v *nativeShape) destroy() { C.surfaceDestroy(v.handle) }
