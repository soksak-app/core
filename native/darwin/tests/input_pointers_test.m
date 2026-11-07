// Checks named pointers of sp_input_pointer_then: two pointers press, drag and release at once in two windows and in one
// window, each view and each page receives its own gesture at its own points with the buttons of its own pointer, and an input
// that would share the state of a window or a page with the open press of another pointer is rejected with SP_INPUT_POINTER_HELD,
// naming that pointer. The rejection for a page that the input method of the system serves needs the key window of the active
// application and is checked only in the activation tier.
//
// The test process is never active, and its windows are not key windows unless a window answers as one. A press passes the
// application only in the key window of the application that is really active, so the case of that window answers both.
#import <Cocoa/Cocoa.h>
#import <WebKit/WebKit.h>
#import <objc/runtime.h>
#import "input_inject.h"
#import "input_press_context.h"
#import "webview_input.h"

static int failures;
static void check(BOOL condition, NSString *message) {
    fprintf(condition ? stdout : stderr, "%s: %s\n", condition ? "PASS" : "FAIL", message.UTF8String);
    if (!condition) failures++;
}
static void spin(double seconds) { [NSRunLoop.currentRunLoop runUntilDate:[NSDate dateWithTimeIntervalSinceNow:seconds]]; }
static void until(BOOL (^done)(void)) { for (int i = 0; i < 500 && !done(); i++) spin(0.01); }
static id evaluate(WKWebView *view, NSString *script) {
    __block id out = nil;
    __block BOOL done = NO;
    [view evaluateJavaScript:script completionHandler:^(id result, NSError *error) { out = [(error ? error.localizedDescription : result) retain]; done = YES; }];
    until(^BOOL { return done; });
    return [out autorelease];
}

// The answer of one input: its result and, for SP_INPUT_POINTER_HELD, the pointer that holds the press and the reason.
typedef struct {
    BOOL done;
    sp_input_result result;
    char holder[64];
    char reason[256];
} SPAnswer;
static void answered(void *context, sp_input_result result, const sp_input_held *held) {
    SPAnswer *answer = context;
    answer->result = result;
    answer->holder[0] = answer->reason[0] = 0;
    if (result == SP_INPUT_POINTER_HELD && held && held->pointer) snprintf(answer->holder, sizeof answer->holder, "%s", held->pointer);
    if (result == SP_INPUT_POINTER_HELD && held && held->reason) snprintf(answer->reason, sizeof answer->reason, "%s", held->reason);
    answer->done = YES;
}
static SPAnswer lastAnswer;
static sp_input_result input(NSWindow *window, const char *pointer, double x, double y, int phase, int button) {
    lastAnswer = (SPAnswer){0};
    sp_input_pointer_then(window, pointer, x, y, phase, button, 0, 0, 1, 2, answered, &lastAnswer);
    until(^BOOL { return lastAnswer.done; });
    sp_input_result result = lastAnswer.done ? lastAnswer.result : (sp_input_result)-1;
    // Each answer is written, so a failing check shows the results that led to it.
    printf("input of %s, phase %d, button %d at %g,%g: result %d %s %s\n", pointer ? pointer : "(null)", phase, button, x, y,
        result, lastAnswer.holder, lastAnswer.reason);
    return result;
}
static BOOL heldBy(const char *pointer) {
    return lastAnswer.result == SP_INPUT_POINTER_HELD && strcmp(lastAnswer.holder, pointer) == 0 && lastAnswer.reason[0] != 0;
}

static NSRect awayFromPointer(NSSize size, CGFloat shift) {
    NSRect screen = NSScreen.mainScreen.visibleFrame;
    NSPoint at = NSEvent.mouseLocation;
    CGFloat left = at.x < NSMidX(screen) ? NSMaxX(screen) - size.width - 20 - shift : NSMinX(screen) + 20 + shift;
    CGFloat bottom = at.y < NSMidY(screen) ? NSMaxY(screen) - size.height - 60 : NSMinY(screen) + 20;
    return NSMakeRect(left, bottom, size.width, size.height);
}

@interface SPFlippedView : NSView
@end
@implementation SPFlippedView
- (BOOL)isFlipped { return YES; }
@end

// Records each mouse event that reaches it: its kind, its point in the content of the window and the buttons that
// +[NSEvent pressedMouseButtons] answers during the delivery, which WebKit reads as the buttons of a page event.
@interface SPRecordingView : NSView
@property(nonatomic, retain) NSMutableArray<NSString *> *seen;
@end
@implementation SPRecordingView
- (instancetype)initWithFrame:(NSRect)frame {
    self = [super initWithFrame:frame];
    _seen = [[NSMutableArray alloc] init];
    [self addTrackingArea:[[[NSTrackingArea alloc] initWithRect:NSZeroRect
        options:NSTrackingMouseMoved | NSTrackingActiveAlways | NSTrackingInVisibleRect owner:self userInfo:nil] autorelease]];
    return self;
}
- (void)dealloc { [_seen release]; [super dealloc]; }
- (void)record:(NSString *)kind event:(NSEvent *)event {
    NSPoint at = [self.window.contentView convertPoint:event.locationInWindow fromView:nil];
    [self.seen addObject:[NSString stringWithFormat:@"%@ %.0f,%.0f buttons %lu", kind, at.x, at.y, (unsigned long)NSEvent.pressedMouseButtons]];
}
- (void)mouseDown:(NSEvent *)event { [self record:@"down" event:event]; }
- (void)mouseDragged:(NSEvent *)event { [self record:@"dragged" event:event]; }
- (void)mouseUp:(NSEvent *)event { [self record:@"up" event:event]; }
- (void)rightMouseDown:(NSEvent *)event { [self record:@"rightDown" event:event]; }
- (void)rightMouseDragged:(NSEvent *)event { [self record:@"rightDragged" event:event]; }
- (void)rightMouseUp:(NSEvent *)event { [self record:@"rightUp" event:event]; }
- (void)mouseMoved:(NSEvent *)event { [self record:@"moved" event:event]; }
@end

// The real activation, which this test gives in place of AppKit.
static BOOL reallyActive;
static BOOL testIsActive(id self, SEL selector) { return reallyActive; }

@interface SPKeyAnswerWindow : NSWindow
@end
@implementation SPKeyAnswerWindow
- (BOOL)isKeyWindow { return YES; }
@end

// A window of width 300 and height 120 with two recording views, the left half and the right half.
static NSWindow *makeWindow(Class kind, CGFloat shift, SPRecordingView **left, SPRecordingView **right) {
    NSWindow *window = [[kind alloc] initWithContentRect:awayFromPointer(NSMakeSize(300, 120), shift)
        styleMask:NSWindowStyleMaskTitled backing:NSBackingStoreBuffered defer:NO];
    [window setReleasedWhenClosed:NO];
    SPFlippedView *content = [[[SPFlippedView alloc] initWithFrame:NSMakeRect(0, 0, 300, 120)] autorelease];
    window.contentView = content;
    *left = [[[SPRecordingView alloc] initWithFrame:NSMakeRect(0, 0, 150, 120)] autorelease];
    *right = [[[SPRecordingView alloc] initWithFrame:NSMakeRect(150, 0, 150, 120)] autorelease];
    [content addSubview:*left];
    [content addSubview:*right];
    [window orderBack:nil];
    return window;
}

static void checkSeen(SPRecordingView *view, NSArray<NSString *> *want, NSString *what) {
    check([view.seen isEqualToArray:want], [NSString stringWithFormat:@"%@: %@ (want %@)", what,
        [view.seen componentsJoinedByString:@"; "], [want componentsJoinedByString:@"; "]]);
}

// Two pointers press, drag and release at once in two windows, one with the left button and one with the right button. Each
// view receives its own gesture, and each delivery answers the buttons of its own pointer.
static void checkTwoWindows(void) {
    SPRecordingView *first = nil, *firstRight = nil, *second = nil, *secondRight = nil;
    NSWindow *one = makeWindow(NSWindow.class, 0, &first, &firstRight);
    NSWindow *two = makeWindow(NSWindow.class, 340, &second, &secondRight);
    check(input(one, "a", 20, 20, 1, 0) == SP_INPUT_DELIVERED, @"pointer a presses the left button in the first window");
    check(input(two, "b", 30, 30, 1, 1) == SP_INPUT_DELIVERED, @"pointer b presses the right button in the second window");
    check(NSEvent.pressedMouseButtons == 3, [NSString stringWithFormat:@"outside a delivery the buttons of every pointer are pressed (%lu)",
        (unsigned long)NSEvent.pressedMouseButtons]);
    check(input(one, "a", 60, 40, 2, 0) == SP_INPUT_DELIVERED, @"pointer a drags");
    check(input(two, "b", 70, 50, 2, 1) == SP_INPUT_DELIVERED, @"pointer b drags");
    check(input(one, "a", 60, 40, 3, 0) == SP_INPUT_DELIVERED, @"pointer a releases");
    check(input(two, "b", 70, 50, 3, 1) == SP_INPUT_DELIVERED, @"pointer b releases");
    checkSeen(first, @[@"down 20,20 buttons 1", @"dragged 60,40 buttons 1", @"up 60,40 buttons 0"],
        @"the view of pointer a receives its gesture with its button");
    checkSeen(second, @[@"rightDown 30,30 buttons 2", @"rightDragged 70,50 buttons 2", @"rightUp 70,50 buttons 0"],
        @"the view of pointer b receives its gesture with its button");
    check(NSEvent.pressedMouseButtons == 0, @"no button stays pressed after both releases");

    // A pointer holds one press of a button, in any window.
    check(input(one, "a", 20, 20, 1, 0) == SP_INPUT_DELIVERED && input(two, "a", 20, 20, 1, 0) == SP_INPUT_PRESS_OPEN,
        @"a press of a button whose press the pointer holds in another window answers press open");
    check(input(two, "a", 40, 20, 2, 0) == SP_INPUT_REJECTED && input(two, "a", 40, 20, 3, 0) == SP_INPUT_REJECTED,
        @"a drag and a release in a window without the press of the pointer are rejected");
    check(input(one, "a", 20, 20, 3, 0) == SP_INPUT_DELIVERED, @"the press of the pointer ends in its window");

    // A move answers the buttons of its pointer while another pointer holds a press in another window.
    [secondRight.seen removeAllObjects];
    check(input(one, "a", 20, 20, 1, 0) == SP_INPUT_DELIVERED, @"pointer a presses again");
    check(input(two, "b", 200, 60, 0, 0) == SP_INPUT_DELIVERED, @"pointer b moves in the other window");
    checkSeen(secondRight, @[@"moved 200,60 buttons 0"], @"the move of pointer b has no button");
    check(input(one, "a", 20, 20, 3, 0) == SP_INPUT_DELIVERED, @"pointer a releases");
    [one close]; [one release];
    [two close]; [two release];
}

// Two pointers press, drag and release at once on two views of one window that is not a key window. A press on a view that
// another pointer holds, and a move in the window, are rejected with the name of that pointer.
static void checkOneWindow(void) {
    SPRecordingView *left = nil, *right = nil;
    NSWindow *window = makeWindow(NSWindow.class, 0, &left, &right);
    check(input(window, "a", 20, 20, 1, 0) == SP_INPUT_DELIVERED, @"pointer a presses the left view");
    check(input(window, "b", 170, 20, 1, 0) == SP_INPUT_DELIVERED, @"pointer b presses the right view of the same window");
    check(input(window, "a", 60, 40, 2, 0) == SP_INPUT_DELIVERED && input(window, "b", 220, 40, 2, 0) == SP_INPUT_DELIVERED,
        @"both pointers drag");
    check(input(window, "b", 40, 90, 1, 1) == SP_INPUT_POINTER_HELD && heldBy("a"),
        [NSString stringWithFormat:@"a press on the view that pointer a holds is rejected naming a (%s: %s)", lastAnswer.holder, lastAnswer.reason]);
    check(input(window, "c", 100, 100, 0, 0) == SP_INPUT_POINTER_HELD && (heldBy("a") || heldBy("b")),
        [NSString stringWithFormat:@"a move in a window in which another pointer holds a press is rejected (%s: %s)", lastAnswer.holder, lastAnswer.reason]);
    check(input(window, "a", 60, 40, 3, 0) == SP_INPUT_DELIVERED && input(window, "b", 220, 40, 3, 0) == SP_INPUT_DELIVERED,
        @"both pointers release");
    checkSeen(left, @[@"down 20,20 buttons 1", @"dragged 60,40 buttons 1", @"up 60,40 buttons 0"],
        @"the left view receives the gesture of pointer a");
    checkSeen(right, @[@"down 170,20 buttons 1", @"dragged 220,40 buttons 1", @"up 220,40 buttons 0"],
        @"the right view receives the gesture of pointer b");
    check(input(window, "b", 40, 90, 1, 0) == SP_INPUT_DELIVERED && input(window, "b", 40, 90, 3, 0) == SP_INPUT_DELIVERED,
        @"after the release of pointer a, pointer b presses its view");
    check(!sp_input_press_open(window, 0) && !sp_input_press_open(window, 1), @"no press stays open in the window");
    [window close]; [window release];

    // AppKit keeps one target of each button of a window that passes presses through -[NSApplication sendEvent:]: the key
    // window of the application that is really active.
    reallyActive = YES;
    SPRecordingView *keyLeft = nil, *keyRight = nil;
    NSWindow *key = makeWindow(SPKeyAnswerWindow.class, 0, &keyLeft, &keyRight);
    check(input(key, "a", 20, 20, 1, 0) == SP_INPUT_DELIVERED, @"pointer a presses in a key window");
    check(input(key, "b", 170, 20, 1, 1) == SP_INPUT_POINTER_HELD && heldBy("a"),
        [NSString stringWithFormat:@"a press of another pointer in a key window that pointer a holds is rejected (%s: %s)", lastAnswer.holder, lastAnswer.reason]);
    check(input(key, "a", 20, 20, 3, 0) == SP_INPUT_DELIVERED, @"pointer a releases in the key window");
    check(input(key, "b", 170, 20, 1, 1) == SP_INPUT_DELIVERED && input(key, "b", 170, 20, 3, 1) == SP_INPUT_DELIVERED,
        @"pointer b presses the key window after that release");
    [key close]; [key release];
    reallyActive = NO;
}

// A window that goes away ends the press of its pointer, and only that one.
static void checkWindowEndsItsPress(void) {
    SPRecordingView *left = nil, *right = nil, *otherLeft = nil, *otherRight = nil;
    NSWindow *kept = makeWindow(NSWindow.class, 0, &left, &right);
    @autoreleasepool {
        NSWindow *gone = makeWindow(NSWindow.class, 340, &otherLeft, &otherRight);
        check(input(kept, "a", 20, 20, 1, 1) == SP_INPUT_DELIVERED && input(gone, "b", 20, 20, 1, 0) == SP_INPUT_DELIVERED,
            @"two pointers press in two windows");
        [gone close];
        [gone release];
    }
    until(^BOOL { return NSEvent.pressedMouseButtons == 2; });
    check(NSEvent.pressedMouseButtons == 2, @"a window that goes away ends the press of its pointer");
    check(input(kept, "b", 20, 20, 1, 0) == SP_INPUT_POINTER_HELD && heldBy("a"),
        @"the pointer of the window that went away presses again, and the view that pointer a holds rejects it");
    check(input(kept, "b", 170, 20, 1, 0) == SP_INPUT_DELIVERED && input(kept, "b", 170, 20, 3, 0) == SP_INPUT_DELIVERED,
        @"the pointer of the window that went away presses another view");
    check(input(kept, "a", 20, 20, 3, 1) == SP_INPUT_DELIVERED && NSEvent.pressedMouseButtons == 0, @"the last release leaves no button");
    [kept close]; [kept release];
}

static NSString *const PAGE = @"<!doctype html><style>html,body{margin:0;height:100%}</style>"
    "<input id='field' style='position:absolute;left:10px;top:10px;width:150px;height:30px'><script>window.seen=[];"
    "for (const type of ['pointerdown','pointermove','pointerup']) addEventListener(type,e=>seen.push(type+' '+e.clientX+','+e.clientY+' '+e.buttons),true);"
    "window.ready=true;</script>";
static WKWebView *makePage(CGFloat shift) {
    NSWindow *window = [[NSWindow alloc] initWithContentRect:awayFromPointer(NSMakeSize(300, 200), shift)
        styleMask:NSWindowStyleMaskTitled backing:NSBackingStoreBuffered defer:NO];
    [window setReleasedWhenClosed:NO];
    WKWebView *view = [[[WKWebView alloc] initWithFrame:NSMakeRect(0, 0, 300, 200)] autorelease];
    window.contentView = view;
    check(webviewInputRegister(view), @"the page registers for pointer input");
    [view loadHTMLString:PAGE baseURL:nil];
    until(^BOOL { return [evaluate(view, @"Boolean(window.ready)") boolValue]; });
    [window orderBack:nil];
    return view;
}
static NSArray<NSString *> *seen(WKWebView *view) {
    NSArray *events = evaluate(view, @"seen");
    return [events isKindOfClass:NSArray.class] ? events : @[];
}

// Two pointers press, drag and release at once on the pages of two windows. Each page receives pointerdown, pointermove and
// pointerup at the points of its pointer with the buttons of that pointer: a release while the other pointer holds the same
// button is a pointerup with no button.
static void checkTwoPages(void) {
    WKWebView *first = makePage(0), *second = makePage(340);
    NSWindow *one = first.window, *two = second.window;
    check(input(one, "a", 50, 100, 1, 0) == SP_INPUT_DELIVERED, @"pointer a presses the first page");
    check(input(two, "b", 80, 120, 1, 0) == SP_INPUT_DELIVERED, @"pointer b presses the second page with the same button");
    check(input(one, "a", 90, 110, 2, 0) == SP_INPUT_DELIVERED && input(two, "b", 120, 130, 2, 0) == SP_INPUT_DELIVERED,
        @"both pointers drag");
    check(input(one, "a", 90, 110, 3, 0) == SP_INPUT_DELIVERED, @"the first page receives the release of pointer a while pointer b holds its press");
    check(input(two, "b", 120, 130, 3, 0) == SP_INPUT_DELIVERED, @"the second page receives the release of pointer b");
    until(^BOOL { return seen(first).count >= 3 && seen(second).count >= 3; });
    NSArray<NSString *> *wantFirst = @[@"pointerdown 50,100 1", @"pointermove 90,110 1", @"pointerup 90,110 0"];
    NSArray<NSString *> *wantSecond = @[@"pointerdown 80,120 1", @"pointermove 120,130 1", @"pointerup 120,130 0"];
    check([seen(first) isEqualToArray:wantFirst], [NSString stringWithFormat:@"the first page sees the gesture of pointer a: %@",
        [seen(first) componentsJoinedByString:@"; "]]);
    check([seen(second) isEqualToArray:wantSecond], [NSString stringWithFormat:@"the second page sees the gesture of pointer b: %@",
        [seen(second) componentsJoinedByString:@"; "]]);

    // A page with a focused field passes its mouse events to its input context. The input method of the system serves only the key
    // window of the active application, so in this application the context answers inside the delivery, and the page sees the
    // buttons of its own pointer while the other pointer holds a press.
    check(input(one, "a", 50, 25, 1, 0) == SP_INPUT_DELIVERED && input(one, "a", 50, 25, 3, 0) == SP_INPUT_DELIVERED,
        @"pointer a focuses the field of the first page");
    until(^BOOL { return [evaluate(first, @"document.activeElement.id") isEqual:@"field"] && first.inputContext != nil; });
    check(first.inputContext != nil, @"the page of the focused field has an input context");
    evaluate(first, @"seen=[]; null");
    check(input(two, "b", 80, 120, 1, 0) == SP_INPUT_DELIVERED, @"pointer b presses the second page");
    check(input(one, "a", 60, 25, 1, 0) == SP_INPUT_DELIVERED && input(one, "a", 70, 25, 2, 0) == SP_INPUT_DELIVERED
        && input(one, "a", 70, 25, 3, 0) == SP_INPUT_DELIVERED,
        @"pointer a presses, drags and releases the focused field while pointer b holds its press");
    check(input(two, "b", 80, 120, 3, 0) == SP_INPUT_DELIVERED, @"pointer b releases");
    until(^BOOL { return seen(first).count >= 3; });
    NSArray<NSString *> *wantField = @[@"pointerdown 60,25 1", @"pointermove 70,25 1", @"pointerup 70,25 0"];
    check([seen(first) isEqualToArray:wantField], [NSString stringWithFormat:@"the page of the focused field sees the gesture of pointer a: %@",
        [seen(first) componentsJoinedByString:@"; "]]);
    [one close]; [one release];
    [two close]; [two release];
}

// Same-window WK views share AppKit tracking/crossing state, unlike the
// two-window case. Record every event, including extra moves, so a crossing
// cannot silently leak another pointer's buttons into an open gesture.
static NSString *const POINTER_AUDIT = @"window.audit=[];window.counts=[0,0,0,0];window.pressed=false;"
    "addEventListener('pointerdown',e=>{counts[0]++;pressed=true;if(e.buttons!==1)counts[3]++;audit.push([e.type,e.clientX,e.clientY,e.buttons,...counts]);});"
    "addEventListener('pointermove',e=>{if(pressed&&e.buttons===1)counts[1]++;else if(e.buttons!==(pressed?1:0))counts[3]++;audit.push([e.type,e.clientX,e.clientY,e.buttons,...counts]);});"
    "addEventListener('pointerup',e=>{counts[2]++;pressed=false;if(e.buttons!==0)counts[3]++;audit.push([e.type,e.clientX,e.clientY,e.buttons,...counts]);});null;";

static void checkPageCounts(WKWebView *view, int downs, int drags, int ups, NSString *stage) {
    NSArray *want = @[@(downs), @(drags), @(ups), @0];
    until(^BOOL {
        NSArray *counts = evaluate(view, @"counts");
        return [counts isKindOfClass:NSArray.class] && counts.count == 4 &&
            ([counts isEqualToArray:want] || [counts[3] intValue] > 0);
    });
    id counts = evaluate(view, @"counts");
    id transcript = evaluate(view, @"audit");
    check([counts isEqual:want], [NSString stringWithFormat:@"same-window %@ counts %@ want %@; all page events %@", stage, counts, want, transcript]);
}

static void checkTwoPagesInOneWindow(void) {
    NSWindow *window = [[NSWindow alloc] initWithContentRect:awayFromPointer(NSMakeSize(600, 200), 0)
        styleMask:NSWindowStyleMaskTitled backing:NSBackingStoreBuffered defer:NO];
    [window setReleasedWhenClosed:NO];
    NSView *root = [[[NSView alloc] initWithFrame:NSMakeRect(0, 0, 600, 200)] autorelease];
    window.contentView = root;
    WKWebView *left = [[[WKWebView alloc] initWithFrame:NSMakeRect(0, 0, 300, 200)] autorelease];
    WKWebView *right = [[[WKWebView alloc] initWithFrame:NSMakeRect(300, 0, 300, 200)] autorelease];
    [root addSubview:left]; [root addSubview:right];
    check(webviewInputRegister(left) && webviewInputRegister(right), @"same-window pages register pointer input");
    [left loadHTMLString:PAGE baseURL:nil]; [right loadHTMLString:PAGE baseURL:nil];
    until(^BOOL { return [evaluate(left, @"Boolean(window.ready)") boolValue] && [evaluate(right, @"Boolean(window.ready)") boolValue]; });
    [window orderBack:nil];
    evaluate(right, POINTER_AUDIT);
    check(input(window, "a", 50, 100, 0, 0) == SP_INPUT_DELIVERED, @"same-window first pointer enters");
    check(input(window, "a", 50, 100, 1, 0) == SP_INPUT_DELIVERED, @"same-window preflight press");
    check(input(window, "b", 380, 120, 0, 0) == SP_INPUT_POINTER_HELD && heldBy("a"), @"same-window foreign hover move is refused");
    check(input(window, "a", 50, 100, 3, 0) == SP_INPUT_DELIVERED, @"same-window preflight release");
    // The E2E reloads the first page after its held-hover rejection probe.
    evaluate(left, @"window.ready=false;null;");
    [left loadHTMLString:PAGE baseURL:nil];
    until(^BOOL { return [evaluate(left, @"Boolean(window.ready)") boolValue]; });
    evaluate(left, POINTER_AUDIT);
    check(input(window, "a", 50, 100, 1, 0) == SP_INPUT_DELIVERED, @"same-window first page press");
    checkPageCounts(left, 1, 0, 0, @"first press");
    check(input(window, "b", 380, 120, 1, 0) == SP_INPUT_DELIVERED, @"same-window second page press");
    checkPageCounts(right, 1, 0, 0, @"second press");
    for (int step = 1; step <= 2; step++) {
        check(input(window, "a", 50 + 12 * step, 100 + 6 * step, 2, 0) == SP_INPUT_DELIVERED, @"same-window first page drag");
        checkPageCounts(left, 1, step, 0, [NSString stringWithFormat:@"first drag %d", step]);
        check(input(window, "b", 380 - 12 * step, 120 + 6 * step, 2, 0) == SP_INPUT_DELIVERED, @"same-window second page drag");
        checkPageCounts(right, 1, step, 0, [NSString stringWithFormat:@"second drag %d", step]);
    }
    check(input(window, "a", 74, 112, 3, 0) == SP_INPUT_DELIVERED, @"same-window first page release");
    checkPageCounts(left, 1, 2, 1, @"first release");
    check(input(window, "b", 356, 132, 3, 0) == SP_INPUT_DELIVERED, @"same-window second page release");
    checkPageCounts(right, 1, 2, 1, @"second release");
    [window close]; [window release];
}

// A pointer name has 1 to SP_INPUT_POINTER_NAME_MAX characters of a-z, 0-9 and -.
static void checkNames(void) {
    SPRecordingView *left = nil, *right = nil;
    NSWindow *window = makeWindow(NSWindow.class, 0, &left, &right);
    char longest[SP_INPUT_POINTER_NAME_MAX + 2];
    memset(longest, 'p', sizeof longest - 1);
    longest[sizeof longest - 1] = 0;
    check(input(window, NULL, 20, 20, 1, 0) == SP_INPUT_REJECTED && input(window, "", 20, 20, 1, 0) == SP_INPUT_REJECTED
        && input(window, "A", 20, 20, 1, 0) == SP_INPUT_REJECTED && input(window, "a b", 20, 20, 1, 0) == SP_INPUT_REJECTED
        && input(window, longest, 20, 20, 1, 0) == SP_INPUT_REJECTED, @"a pointer name out of its form is rejected");
    longest[SP_INPUT_POINTER_NAME_MAX] = 0;
    check(input(window, longest, 20, 20, 1, 0) == SP_INPUT_DELIVERED && input(window, longest, 20, 20, 3, 0) == SP_INPUT_DELIVERED,
        @"the longest pointer name is accepted");
    check(left.seen.count == 2, @"only the accepted name reached the view");
    [window close]; [window release];
}

int main(void) { @autoreleasepool {
    method_setImplementation(class_getInstanceMethod(NSApplication.class, @selector(isActive)), (IMP)testIsActive);
    [NSApplication sharedApplication];
    [NSApp setActivationPolicy:NSApplicationActivationPolicyProhibited];
    [NSApp finishLaunching];
    [NSApp setActivationPolicy:NSApplicationActivationPolicyAccessory];
    checkTwoWindows();
    checkOneWindow();
    checkWindowEndsItsPress();
    checkTwoPages();
    checkTwoPagesInOneWindow();
    checkNames();
    if (failures) fprintf(stderr, "FAIL: %d checks of named pointers failed\n", failures);
    else printf("PASS: named pointers\n");
    return failures ? 1 : 0;
} }
