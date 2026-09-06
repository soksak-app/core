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

// One message from a page this app serves. Declared here because a Go function
// exported to C cannot live in a file that also holds C definitions.
extern void surfaceMessage(char* json);

// The channel a page uses to reach this app.
//
// A surface page is loaded from the loopback server and has no Wails binding, so
// it used to speak over HTTP. WKWebViews share one network process with six
// connections per host, and a page that holds one for as long as it lives spends
// a budget that the number of surfaces can exhaust. A message handler is not a
// connection and there is no budget to spend.
@interface SPBridge : NSObject <WKScriptMessageHandler>
@end

@implementation SPBridge
- (void)userContentController:(WKUserContentController*)controller
      didReceiveScriptMessage:(WKScriptMessage*)message {
    surfaceMessage((char*)[[message body] UTF8String]);
}
@end

// The script every page this app serves starts with. `boot` is the value the
// page would otherwise have to fetch, so it is there before the first script
// runs and no request is made for it.
static NSString* surfaceScript(const char* boot) {
    return [NSString stringWithFormat:
        @"window.__spBoot = %s;"
         "window.__spOn = {};"
         "window.__spCall = function (name, arg) {"
         "  var body = Object.assign({ name: name }, arg || {});"
         "  window.webkit.messageHandlers.host.postMessage(JSON.stringify(body));"
         "};"
         "window.__spDeliver = function (name, data) {"
         "  var fn = window.__spOn[name]; if (fn) fn(data);"
         "};",
        boot];
}

// Builds a webview on this app's message channel, loading url and painting the
// given colour where its page has not painted yet.
static WKWebView* surfaceWebView(const char* url, double w, double h,
                                 double red, double green, double blue, double alpha,
                                 const char* boot) {
    WKWebViewConfiguration* config = [[WKWebViewConfiguration alloc] init];
    WKUserContentController* controller = [[WKUserContentController alloc] init];
    [controller addUserScript:[[WKUserScript alloc]
        initWithSource:surfaceScript(boot)
         injectionTime:WKUserScriptInjectionTimeAtDocumentStart
      forMainFrameOnly:YES]];
    [controller addScriptMessageHandler:[[SPBridge alloc] init] name:@"host"];
    config.userContentController = controller;
    WKWebView* view = [[WKWebView alloc] initWithFrame:NSMakeRect(0, 0, w, h) configuration:config];
    // The colour the view shows where its page has not painted. Public since
    // macOS 12; without it that area is white.
    if (@available(macOS 12.0, *)) {
        view.underPageBackgroundColor =
            [NSColor colorWithSRGBRed:red green:green blue:blue alpha:alpha];
    }
    [view setWantsLayer:YES];
    view.layer.backgroundColor =
        [[NSColor colorWithSRGBRed:red green:green blue:blue alpha:alpha] CGColor];
    NSURL* target = [NSURL URLWithString:[NSString stringWithUTF8String:url]];
    [view loadRequest:[NSURLRequest requestWithURL:target]];
    return view;
}

// Not under ARC, so the view is retained here and released in surfaceDestroy.
static void* surfaceCreate(void* nsWindow, const char* url, double x, double y, double w, double h,
                           double red, double green, double blue, double alpha,
                           const char* boot) {
    NSWindow* window = (NSWindow*)nsWindow;
    WKWebView* view = surfaceWebView(url, w, h, red, green, blue, alpha, boot);
    view.frame = surfaceAligned(window, x, y, w, h);
    [[window contentView] addSubview:view positioned:NSWindowAbove relativeTo:nil];
    [view retain];
    return (void*)view;
}

// The modal's window. A panel rather than a plain window so the app's own window
// keeps its active title bar while this one holds the keyboard.
//
// It has to be able to become key. A webview sets the cursor only while its window
// is the key one, and a borderless window refuses key by default, so without this
// the modal would show the arrow everywhere.
@interface SPOverlayPanel : NSPanel
@end

@implementation SPOverlayPanel
- (BOOL)canBecomeKeyWindow { return YES; }
@end

// The modal is a child window, not a view beside the surfaces.
//
// A webview sets the cursor from its own document whenever the pointer moves over
// its frame, and it checks only that its window is the one under the pointer, not
// that it is the view under the pointer. Two webviews stacked in one window both
// pass that check, so a point covered by both gets two cursors and whichever reply
// lands last wins; which one that is changes from move to move. A child window is
// a different window, so the views below it fail the check and leave the cursor to
// the one on top.
//
// The window is borderless and not opaque, so the webview's rounded corners show
// what is behind them rather than black.
static void* overlayCreate(void* nsWindow, const char* url, const char* name,
                           double x, double y, double w, double h,
                           double red, double green, double blue, double alpha,
                           const char* boot) {
    NSWindow* parent = (NSWindow*)nsWindow;
    NSRect frame = [parent convertRectToScreen:NSMakeRect(x, y, MAX(w, 1), MAX(h, 1))];
    NSWindow* child = [[SPOverlayPanel alloc] initWithContentRect:frame
                                                        styleMask:NSWindowStyleMaskBorderless
                                                          backing:NSBackingStoreBuffered
                                                            defer:NO];
    [child setOpaque:NO];
    [child setBackgroundColor:[NSColor clearColor]];
    [child setHasShadow:YES];
    [child setReleasedWhenClosed:NO];
    // A borderless window draws no title, but the system and assistive software
    // name the window by it. A panel stays out of the Windows menu by class.
    [child setTitle:[NSString stringWithUTF8String:name]];
    WKWebView* view = surfaceWebView(url, w, h, red, green, blue, alpha, boot);
    [view setAutoresizingMask:NSViewWidthSizable | NSViewHeightSizable];
    [child setContentView:view];
    // Not attached to the parent yet, and not ordered on screen. A window is not
    // visible until it is ordered, and ordering a child window out takes it off
    // its parent's list, so attaching before there is anything to show would
    // detach it again the moment it is hidden.
    return (void*)child;
}

// Moves the modal's window. The frame arrives in the parent window's coordinates.
static void overlaySetFrame(void* childWindow, void* nsWindow,
                            double x, double y, double w, double h) {
    NSWindow* child = (NSWindow*)childWindow;
    NSWindow* parent = (NSWindow*)nsWindow;
    [child setFrame:[parent convertRectToScreen:NSMakeRect(x, y, MAX(w, 1), MAX(h, 1))]
            display:YES];
}

// Clips the modal's corners. The clip is in the view's own pixels, so it is
// reapplied whenever the window is resized.
static void overlaySetCornerRadius(void* childWindow, double radius) {
    NSWindow* child = (NSWindow*)childWindow;
    NSView* view = [child contentView];
    [view setWantsLayer:YES];
    view.layer.cornerRadius = radius;
    view.layer.masksToBounds = YES;
}

// Attaches the modal to the app's window and gives it the keyboard, which is also
// what lets its page set the cursor. A child window moves with its parent.
static void overlayAttach(void* childWindow, void* nsWindow) {
    NSWindow* child = (NSWindow*)childWindow;
    NSWindow* parent = (NSWindow*)nsWindow;
    [parent addChildWindow:child ordered:NSWindowAbove];
    [child makeKeyWindow];
}

// Takes the modal off the app's window and hands the keyboard back.
static void overlayDetach(void* childWindow, void* nsWindow) {
    NSWindow* child = (NSWindow*)childWindow;
    NSWindow* parent = (NSWindow*)nsWindow;
    [parent removeChildWindow:child];
    [child orderOut:nil];
    [parent makeKeyWindow];
}

static void overlayEval(void* childWindow, const char* js) {
    NSWindow* child = (NSWindow*)childWindow;
    WKWebView* view = (WKWebView*)[child contentView];
    [view evaluateJavaScript:[NSString stringWithUTF8String:js] completionHandler:nil];
}

static void overlayDestroy(void* childWindow) {
    NSWindow* child = (NSWindow*)childWindow;
    NSWindow* parent = [child parentWindow];
    [parent removeChildWindow:child];
    [child orderOut:nil];
    [child close];
    [child release];
    [parent makeKeyWindow];
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

static void surfaceSetFrame(void* handle, double x, double y, double w, double h) {
    WKWebView* view = (WKWebView*)handle;
    NSWindow* window = [view window];
    if (window == nil) return;
    view.frame = surfaceAligned(window, x, y, w, h);
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

// Runs a line of script in a page this app serves. This is how a message goes
// the other way.
static void surfaceEval(void* handle, const char* js) {
    WKWebView* view = (WKWebView*)handle;
    [view evaluateJavaScript:[NSString stringWithUTF8String:js] completionHandler:nil];
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

func newNativeView(window unsafe.Pointer, url string, x, y, w, h float64, background [4]float64,
	boot string) *nativeView {
	target := C.CString(url)
	defer C.free(unsafe.Pointer(target))
	start := C.CString(boot)
	defer C.free(unsafe.Pointer(start))
	handle := C.surfaceCreate(window, target, C.double(x), C.double(y), C.double(w), C.double(h),
		C.double(background[0]), C.double(background[1]), C.double(background[2]),
		C.double(background[3]), start)
	if handle == nil {
		return nil
	}
	return &nativeView{handle: handle}
}

func (v *nativeView) setFrame(x, y, w, h float64) {
	C.surfaceSetFrame(v.handle, C.double(x), C.double(y), C.double(w), C.double(h))
}

// setResizing brackets a run of resizes. The page reports whether the update it
// just sent is the last one, and a run that is not over is a live resize.
func (v *nativeView) setResizing(live bool) {
	if live {
		C.surfaceBeginLiveResize(v.handle)
		return
	}
	C.surfaceEndLiveResize(v.handle)
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

// eval runs a line of script in the page this view holds.
func (v *nativeView) eval(js string) {
	line := C.CString(js)
	defer C.free(unsafe.Pointer(line))
	C.surfaceEval(v.handle, line)
}

func (v *nativeView) destroy() { C.surfaceDestroy(v.handle) }

// id identifies this view among the ones a press passes through.
func (v *nativeView) id() uintptr { return uintptr(v.handle) }

// watchMouse starts the monitor. Called once, when the first surface appears.
func watchMouse(window unsafe.Pointer) { C.surfaceWatchMouse(window) }

// nativeOverlay is the modal's own window, a child of the app's.
type nativeOverlay struct {
	handle unsafe.Pointer
	parent unsafe.Pointer
}

func newNativeOverlay(window unsafe.Pointer, url, name string, x, y, w, h float64,
	background [4]float64, boot string) *nativeOverlay {
	target := C.CString(url)
	defer C.free(unsafe.Pointer(target))
	title := C.CString(name)
	defer C.free(unsafe.Pointer(title))
	start := C.CString(boot)
	defer C.free(unsafe.Pointer(start))
	handle := C.overlayCreate(window, target, title,
		C.double(x), C.double(y), C.double(w), C.double(h),
		C.double(background[0]), C.double(background[1]), C.double(background[2]),
		C.double(background[3]), start)
	if handle == nil {
		return nil
	}
	return &nativeOverlay{handle: handle, parent: window}
}

func (v *nativeOverlay) setFrame(x, y, w, h float64) {
	C.overlaySetFrame(v.handle, v.parent, C.double(x), C.double(y), C.double(w), C.double(h))
}

func (v *nativeOverlay) show() { C.overlayAttach(v.handle, v.parent) }

func (v *nativeOverlay) hide() { C.overlayDetach(v.handle, v.parent) }

func (v *nativeOverlay) setCornerRadius(radius float64) {
	C.overlaySetCornerRadius(v.handle, C.double(radius))
}

func (v *nativeOverlay) eval(js string) {
	line := C.CString(js)
	defer C.free(unsafe.Pointer(line))
	C.overlayEval(v.handle, line)
}

func (v *nativeOverlay) destroy() { C.overlayDestroy(v.handle) }

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
