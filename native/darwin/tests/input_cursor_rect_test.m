// Checks that the cursor rect of a native view under the injected point of the virtual key window keeps its cursor when the
// page of a web view beside it answers an earlier move with its cursor later. The page sets its cursor as its web content
// process answers a move, and WebKit sets that cursor unless AppKit keeps the cursor of a cursor rect
// (PageClientImpl::setCursor), so the injected move sets the cursor of the cursor rect as AppKit does for the pointer.
//
// The test process is never active. The value of the real activation is a replacement of isActive and the buttons of a person
// a replacement of pressedMouseButtons, both set before the virtual state replaces them, as in input_virtual_test.
#import <Cocoa/Cocoa.h>
#import <WebKit/WebKit.h>
#import <objc/runtime.h>
#import "input_inject.h"
#import "input_virtual.h"
#import "private/webkit.h"
#import "support/event_wait.h"

static int failures;
static void check(BOOL condition, NSString *message) {
    fprintf(condition ? stdout : stderr, "%s: %s\n", condition ? "PASS" : "FAIL", message.UTF8String);
    if (!condition) failures++;
}
static id evaluate(WKWebView *view, NSString *script) {
    __block id out = nil;
    __block BOOL done = NO;
    [view evaluateJavaScript:script completionHandler:^(id result, NSError *error) { out = [(error ? error.localizedDescription : result) retain]; done = YES; }];
    eventWait([@"JavaScript answers " stringByAppendingString:script], ^BOOL { return done; });
    return [out autorelease];
}
// Waits until WebKit has given the page every mouse event that its view received before. The web content process sends the
// cursor of a mouse event before it reports the event handled, so the cursor of each of those events has been set when it ends.
static void drain(WKWebView *view) {
    __block BOOL done = NO;
    [view _doAfterProcessingAllPendingMouseEvents:^{ done = YES; }];
    eventWait(@"WebKit has processed the pending mouse events", ^BOOL { return done; });
}

static BOOL testIsActive(id self, SEL selector) { return NO; }
static NSUInteger testButtons(id self, SEL selector) { return 0; }

// The navigation delegate of the page. It is kept on its web view, which does not retain its delegate.
@interface SPPageLoad : NSObject <WKNavigationDelegate>
@property BOOL finished;
@end
@implementation SPPageLoad
- (void)webView:(WKWebView *)view didFinishNavigation:(WKNavigation *)navigation {
    (void)view;
    (void)navigation;
    self.finished = YES;
}
@end

// A native view whose cursor rect covers its bounds with the pointing hand, and which takes cursorUpdate: from NSView.
@interface SPHandRectView : NSView
@end
@implementation SPHandRectView
- (void)resetCursorRects { [self addCursorRect:self.bounds cursor:NSCursor.pointingHandCursor]; }
@end

// Whether the cursor that the application set for window as the virtual key window is the cursor named name.
static BOOL cursorIs(NSWindow *window, NSString *name) {
    const char *cursor = sp_input_virtual_cursor(window);
    return cursor && [@(cursor) isEqualToString:name];
}
static NSString *cursorOf(NSWindow *window) {
    const char *cursor = sp_input_virtual_cursor(window);
    return cursor ? @(cursor) : @"none";
}

// The page: its left half sets the crosshair cursor and its right half the text cursor, and it records the element of each move.
static NSString *const PAGE = @"<!doctype html><style>html,body{margin:0;height:100%}div{position:absolute;top:0;height:100%;width:100px}"
    "</style><div id='cross' style='left:0;cursor:crosshair'></div><div id='text' style='left:100px;cursor:text'></div><script>"
    "window.over=[];addEventListener('mousemove',e=>over.push(e.target.id),true);</script>";

int main(void) { @autoreleasepool {
    setvbuf(stdout, NULL, _IOLBF, 0);
    [NSApplication sharedApplication];
    [NSApp setActivationPolicy:NSApplicationActivationPolicyProhibited];
    [NSApp finishLaunching];
    [NSApp setActivationPolicy:NSApplicationActivationPolicyAccessory];
    method_setImplementation(class_getInstanceMethod(NSApplication.class, @selector(isActive)), (IMP)testIsActive);
    method_setImplementation(class_getClassMethod(NSEvent.class, @selector(pressedMouseButtons)), (IMP)testButtons);

    // The window holds the page at x 0 to 200 and the native view at x 220 to 420. A window of the mygo workbench holds its
    // pages and its content this way, and its cursor rects are on.
    NSRect screen = NSScreen.mainScreen.visibleFrame;
    NSWindow *window = [[NSWindow alloc] initWithContentRect:NSMakeRect(NSMinX(screen) + 20, NSMinY(screen) + 20, 420, 300)
        styleMask:NSWindowStyleMaskTitled backing:NSBackingStoreBuffered defer:NO];
    [window setReleasedWhenClosed:NO];
    WKWebView *page = [[[WKWebView alloc] initWithFrame:NSMakeRect(0, 0, 200, 300)] autorelease];
    SPHandRectView *hand = [[[SPHandRectView alloc] initWithFrame:NSMakeRect(220, 0, 200, 300)] autorelease];
    [window.contentView addSubview:page];
    [window.contentView addSubview:hand];
    SPPageLoad *load = [[[SPPageLoad alloc] init] autorelease];
    page.navigationDelegate = load;
    [page loadHTMLString:PAGE baseURL:nil];
    [window orderBack:nil];
    eventWait(@"the navigation of the page finishes", ^BOOL { return load.finished; });
    page.navigationDelegate = nil;
    check(window.areCursorRectsEnabled, @"the window manages cursor rects");

    // Each move is sent before the cursor is read: the arguments of a call have no order of evaluation.
    sp_input_result ontoRect = sp_input_pointer(window, 320, 150, 0, 0, 0, 0);
    check(ontoRect == SP_INPUT_DELIVERED && sp_input_virtual_is(window), @"a move onto the native view makes the window the virtual key window");
    check(cursorIs(window, @"pointingHand"), [NSString stringWithFormat:@"a move onto a cursor rect sets its cursor (%@)", cursorOf(window)]);

    // Over the page AppKit keeps no cursor of a cursor rect, so the page sets its cursor.
    check(sp_input_pointer(window, 50, 150, 0, 0, 0, 0) == SP_INPUT_DELIVERED, @"a move onto the page is delivered");
    drain(page);
    eventWait(@"the cursor of the virtual key window is the crosshair of the page", ^BOOL { return cursorIs(window, @"crosshair"); });

    // A move over the text of the page and a move onto the native view in one turn: the page answers the first move with the
    // text cursor after the second move, as it answers a move of a person that went on to the native content.
    evaluate(page, @"over.length=0;null");
    sp_input_result overText = sp_input_pointer(window, 150, 150, 0, 0, 0, 0);
    sp_input_result backOntoRect = sp_input_pointer(window, 320, 150, 0, 0, 0, 0);
    check(overText == SP_INPUT_DELIVERED && backOntoRect == SP_INPUT_DELIVERED, @"the move over the text and the move onto the native view are delivered");
    check(cursorIs(window, @"pointingHand"), [NSString stringWithFormat:@"the move onto the cursor rect sets its cursor again (%@)", cursorOf(window)]);
    drain(page);
    NSArray *over = evaluate(page, @"over");
    check([over containsObject:@"text"], [NSString stringWithFormat:@"the page took the move over its text (%@)", [over componentsJoinedByString:@","]]);
    check(cursorIs(window, @"pointingHand"),
        [NSString stringWithFormat:@"a page cursor that answers an earlier move after the move onto the cursor rect leaves the cursor of the rect (%@)", cursorOf(window)]);

    // Back over the page AppKit keeps no cursor of a cursor rect again, so the page sets its cursor.
    check(sp_input_pointer(window, 50, 150, 0, 0, 0, 0) == SP_INPUT_DELIVERED, @"a move back onto the page is delivered");
    drain(page);
    eventWait(@"the cursor of the virtual key window is the crosshair of the page again", ^BOOL { return cursorIs(window, @"crosshair"); });

    sp_input_virtual_end("no state");
    check(NSCursor.currentCursor != NSCursor.pointingHandCursor && NSCursor.currentCursor != NSCursor.crosshairCursor,
        @"AppKit never held a cursor of the virtual key window");
    [window close];
    [window release];
    return failures ? 1 : 0;
} }
