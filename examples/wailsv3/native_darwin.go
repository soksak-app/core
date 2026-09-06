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

// Tells the view a run of resizes has begun, and that it has ended. A webview
// paints what it covers; area it does not cover yet is its own white until the
// page draws there, which is a frame or more behind a resize. Between these two
// calls WebKit holds what it has drawn instead of showing that white.
static void surfaceBeginLiveResize(void* handle) {
    [(WKWebView*)handle viewWillStartLiveResize];
}

static void surfaceEndLiveResize(void* handle) {
    [(WKWebView*)handle viewDidEndLiveResize];
}

// Moves a shape's view, on the display's pixels so its edges stay crisp.
static void shapeSetFrame(void* handle, double x, double y, double w, double h) {
    NSView* view = (NSView*)handle;
    NSWindow* window = [view window];
    if (window == nil) return;
    view.frame = surfaceAligned(window, x, y, w, h);
}

// The frame a surface is at now, in the window content view's coordinates
// measured from its top left, which is what the page declared.
static void surfaceFrameNow(void* handle, double* out) {
    NSView* view = (NSView*)handle;
    NSView* content = [view superview];
    if (content == nil) return;
    NSRect f = view.frame;
    out[0] = f.origin.x;
    out[1] = content.bounds.size.height - f.origin.y - f.size.height;
    out[2] = f.size.width;
    out[3] = f.size.height;
}

// Sets the view's alpha. The page dims a surface that has lost focus.
static void surfaceSetAlpha(void* handle, double alpha) {
    WKWebView* view = (WKWebView*)handle;
    [view setAlphaValue:alpha];
}

// Raises the view above its siblings. A view added later is above the earlier
// ones, so a modal is raised again after a surface is added.
static void surfaceRaise(void* handle) {
    WKWebView* view = (WKWebView*)handle;
    NSView* parent = [view superview];
    if (parent == nil) return;
    [parent addSubview:view positioned:NSWindowAbove relativeTo:nil];
}

// Reports whether one view is a surface. Returns non-zero for a surface, and the
// walk up from the hit view stops there.
extern int surfaceHit(void* view);

// Reports one step of a left-button drag, in the page's coordinates.
// phase is 0 for a press, 1 for a move, 2 for a release.
extern void surfacePoint(int phase, double x, double y);

// Walks up from a view to the content view, reporting the first surface. Returns
// whether one was found, which is also whether the input began on this app's own
// views rather than on the page.
static int surfaceWalk(NSView* view, NSView* content) {
    while (view != nil && view != content) {
        if (surfaceHit((void*)view)) {
            return 1;
        }
        view = [view superview];
    }
    return 0;
}

// Whether the button went down on one of this app's views. A drag that began on
// the page is the page's own and needs nothing from here; forwarding it would put
// one message per pointer move on the same thread that has to redraw the plane.
static int surfaceDragging = 0;

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
static void surfaceWatchMouse(void* nsWindow) {
    NSWindow* window = (NSWindow*)nsWindow;
    NSEventMask mask = NSEventMaskLeftMouseDown | NSEventMaskLeftMouseDragged
                     | NSEventMaskLeftMouseUp | NSEventMaskKeyDown;
    [NSEvent addLocalMonitorForEventsMatchingMask:mask
                                          handler:^NSEvent*(NSEvent* event) {
        if ([event window] == window) {
            NSView* content = [window contentView];
            NSEventType type = [event type];
            if (type == NSEventTypeKeyDown) {
                NSResponder* first = [window firstResponder];
                if ([first isKindOfClass:[NSView class]]) {
                    surfaceWalk((NSView*)first, content);
                }
            } else {
                NSPoint at = [event locationInWindow];
                double x = at.x;
                double y = [content bounds].size.height - at.y;
                if (type == NSEventTypeLeftMouseDown) {
                    surfaceDragging = surfaceWalk([content hitTest:at], content);
                    if (surfaceDragging) surfacePoint(0, x, y);
                } else if (surfaceDragging) {
                    surfacePoint(type == NSEventTypeLeftMouseDragged ? 1 : 2, x, y);
                    if (type == NSEventTypeLeftMouseUp) surfaceDragging = 0;
                }
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

import "unsafe"

// nativeView is one webview inside the window.
type nativeView struct{ handle unsafe.Pointer }

// surfaceFrame reports where a surface is now, in the page's coordinates. The
// host aligns a declared rect to the display's pixels, so this is not the rect
// the page sent and the page is told the difference.
func surfaceFrame(view unsafe.Pointer) Rect {
	var out [4]C.double
	C.surfaceFrameNow(view, &out[0])
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
	C.shapeSetFrame(v.handle, C.double(x), C.double(y), C.double(w), C.double(h))
}

func (v *nativeShape) setStyle(radius, lineWidth float64, fill, line [4]float64) {
	C.shapeSetStyle(v.handle, C.double(radius), C.double(lineWidth),
		C.double(fill[0]), C.double(fill[1]), C.double(fill[2]), C.double(fill[3]),
		C.double(line[0]), C.double(line[1]), C.double(line[2]), C.double(line[3]))
}

func (v *nativeShape) raise() { C.surfaceRaise(v.handle) }

func (v *nativeShape) destroy() { C.shapeDestroy(v.handle) }
