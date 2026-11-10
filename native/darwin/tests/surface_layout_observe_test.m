// The layout observer reports where the transaction of a window starts and ends, and a settled wait takes the block that
// brings the content of the window to the screen. No window of this check is put on screen.
#import <Cocoa/Cocoa.h>
#import <QuartzCore/QuartzCore.h>
#import <WebKit/WebKit.h>
#import "private/webkit.h"
#import "surface_layout.h"
#import "support/event_wait.h"

static int failures;

static void check(BOOL ok, NSString *message) {
    fprintf(ok ? stdout : stderr, "%s: %s\n", ok ? "PASS" : "FAIL", message.UTF8String);
    if (!ok) failures++;
}

// A web view that holds the completion of its next presentation until the check releases it.
@interface SPHeldPresentation : WKWebView
@property(nonatomic, copy) void (^held)(void);
@end
@implementation SPHeldPresentation
- (void)_doAfterNextPresentationUpdate:(void (^)(void))completion { self.held = completion; }
- (void)dealloc { [_held release]; [super dealloc]; }
@end

static NSString *const transactionMarker = @"soksak.layout-observe";
static NSMutableArray<NSString *> *events;
static void *firstWindow;
static void *secondWindow;
static BOOL endedInOpenTransaction;

static NSString *nameOf(void *window) { return window == firstWindow ? @"first" : window == secondWindow ? @"second" : @"other"; }
static void record(NSString *event, void *window) { [events addObject:[NSString stringWithFormat:@"%@ %@", event, nameOf(window)]]; }

static NSString *recorded(void) {
    NSString *text = [events componentsJoinedByString:@", "];
    [events removeAllObjects];
    return text;
}

// Each ready of the check marks the Core Animation transaction, and a value of a transaction ends with its commit.
static void (^readyRecorder(void *window))(int) {
    return [[^(int allowed) {
        [events addObject:[NSString stringWithFormat:@"ready%@ %@", allowed ? @"" : @" refused", nameOf(window)]];
        if (allowed) [CATransaction setValue:@YES forKey:transactionMarker];
    } copy] autorelease];
}

static void checkStartedPrecedesReady(void) {
    surfaceLayoutBegin(firstWindow, 1, readyRecorder(firstWindow));
    check([CATransaction valueForKey:transactionMarker] != nil, @"the marker is readable inside the open transaction");
    surfaceLayoutBegin(firstWindow, 2, readyRecorder(firstWindow));
    NSString *order = recorded();
    check([order isEqualToString:@"started first, ready first, started first, ready first"],
        [NSString stringWithFormat:@"started precedes ready of each preparation, a newer preparation of the same window included (%@)", order]);
    check(surfaceLayoutCommit(firstWindow, 2), @"the newest preparation commits");
    order = recorded();
    check([order isEqualToString:@"ended first"], [NSString stringWithFormat:@"a commit ends the transaction once (%@)", order]);
    check(!endedInOpenTransaction, @"ended runs after the Core Animation transaction commits");
}

static void checkDeferredCommit(SPHeldPresentation *view) {
    surfaceLayoutBegin(firstWindow, 3, readyRecorder(firstWindow));
    surfaceLayoutBegin(secondWindow, 4, readyRecorder(secondWindow));
    __block BOOL presented = NO;
    check(surfaceLayoutJoinView(firstWindow, 3, view, ^{ presented = YES; }), @"the view joins the transaction");
    check(surfaceLayoutCommit(firstWindow, 3), @"the commit waits for the joined view");
    NSString *order = recorded();
    check([order isEqualToString:@"started first, ready first"],
        [NSString stringWithFormat:@"a commit that waits for a joined view has not ended the transaction (%@)", order]);
    check(view.held != nil, @"the join waits for the presentation of the view");
    if (view.held) view.held();
    view.held = nil;
    check(presented, @"the joined view presented");
    order = recorded();
    check([order isEqualToString:@"ended first, started second, ready second"],
        [NSString stringWithFormat:@"ended of a deferred commit follows the joined view and precedes the next waiting transaction of another window (%@)", order]);
    check(!endedInOpenTransaction, @"ended of a deferred commit runs after the Core Animation transaction commits");
    check(surfaceLayoutCommit(secondWindow, 4), @"the waiting transaction of the other window commits");
    order = recorded();
    check([order isEqualToString:@"ended second"], [NSString stringWithFormat:@"the second transaction ends (%@)", order]);
}

static void checkCancel(void) {
    surfaceLayoutBegin(firstWindow, 5, readyRecorder(firstWindow));
    surfaceLayoutBegin(secondWindow, 6, readyRecorder(secondWindow));
    surfaceLayoutCancel(firstWindow);
    NSString *order = recorded();
    check([order isEqualToString:@"started first, ready first, ended first, started second, ready second"],
        [NSString stringWithFormat:@"ended of a cancel precedes the next waiting transaction (%@)", order]);
    check(!endedInOpenTransaction, @"ended of a cancel runs after the Core Animation transaction commits");
    surfaceLayoutCancelTicket(secondWindow, 6);
    order = recorded();
    check([order isEqualToString:@"ended second"], [NSString stringWithFormat:@"a cancel of a ticket ends its transaction (%@)", order]);
    surfaceLayoutBegin(firstWindow, 7, readyRecorder(firstWindow));
    surfaceLayoutBegin(secondWindow, 8, readyRecorder(secondWindow));
    surfaceLayoutCancel(secondWindow);
    order = recorded();
    check([order isEqualToString:@"started first, ready first, ready refused second"],
        [NSString stringWithFormat:@"a preparation that never started reports neither started nor ended (%@)", order]);
    check(surfaceLayoutCommit(firstWindow, 7), @"the open transaction commits");
    [events removeAllObjects];
}

static void checkSettledWithBlock(NSWindow *window) {
    check(window.screen != nil, @"the window of the settled check lies on a screen, so its wait has a display refresh");
    __block int presentations = 0;
    __block void (^presented)(const char *) = nil;
    void (^present)(void (^)(const char *)) = ^(void (^callback)(const char *)) {
        presentations++;
        presented = [callback copy];
    };
    __block double displayed = 0;
    __block BOOL settled = NO;
    surfaceLayoutAfterSettled(window, present, ^(double at, const char *error) {
        check(error == NULL, @"a settled wait without a failure has no error");
        displayed = at;
        settled = YES;
    });
    check(presentations == 1 && !settled, @"the wait asks the block and does not end before the block calls back");
    double called = CACurrentMediaTime() * 1000;
    presented(NULL);
    check(!settled, @"the callback of the block does not end the wait before the next display refresh");
    eventWait(@"the settled wait ends at the next display refresh", ^BOOL { return settled; });
    check(displayed >= called, [NSString stringWithFormat:@"the wait reports the display refresh after the block called back (%f, called %f)", displayed, called]);
    [presented release];
    presented = nil;

    // An open transaction and a waiting transaction of the window both hold the wait.
    presentations = 0;
    settled = NO;
    surfaceLayoutBegin(firstWindow, 9, readyRecorder(firstWindow));
    surfaceLayoutBegin(window, 10, readyRecorder(window));
    surfaceLayoutAfterSettled(window, present, ^(double at, const char *error) { settled = YES; });
    check(presentations == 0, @"the wait does not ask the block while a transaction of the window waits");
    check(surfaceLayoutCommit(firstWindow, 9), @"the transaction of the other window commits");
    check(presentations == 0, @"the wait does not ask the block while a transaction of the window is open");
    check(surfaceLayoutCommit(window, 10), @"the transaction of the window commits");
    check(presentations == 1, @"the wait asks the block when no transaction of the window remains");

    // A transaction that opens while the block presents starts the wait again.
    surfaceLayoutBegin(window, 11, readyRecorder(window));
    presented(NULL);
    [presented release];
    presented = nil;
    check(presentations == 1 && !settled, @"the wait does not end while a newer transaction of the window is open");
    check(surfaceLayoutCommit(window, 11), @"the newer transaction commits");
    check(presentations == 2, @"the end of the newer transaction asks the block again");
    presented(NULL);
    [presented release];
    presented = nil;
    eventWait(@"the settled wait ends after the block presents the newer transaction", ^BOOL { return settled; });

    __block const char *failure = NULL;
    surfaceLayoutAfterSettled(window, ^(void (^callback)(const char *)) { callback("the frame failed"); },
        ^(double at, const char *error) { failure = strdup(error); });
    check(failure != NULL && strcmp(failure, "the frame failed") == 0, @"a failure of the block ends the wait with that failure");
    free((void *)failure);

    failure = NULL;
    surfaceLayoutAfterSettled(NULL, present, ^(double at, const char *error) { failure = strdup(error); });
    check(failure != NULL && strstr(failure, "window") != NULL, @"a wait without a window reports its cause");
    free((void *)failure);
    failure = NULL;
    surfaceLayoutAfterSettled(window, NULL, ^(double at, const char *error) { failure = strdup(error); });
    check(failure != NULL && strstr(failure, "presentation") != NULL, @"a wait without a block reports its cause");
    free((void *)failure);
    [events removeAllObjects];
}

int main(void) { @autoreleasepool {
    [NSApplication sharedApplication];
    [NSApp setActivationPolicy:NSApplicationActivationPolicyProhibited];
    events = [[NSMutableArray alloc] init];
    NSWindow *first = [[NSWindow alloc] initWithContentRect:NSMakeRect(100, 100, 200, 100) styleMask:NSWindowStyleMaskBorderless
        backing:NSBackingStoreBuffered defer:NO];
    first.releasedWhenClosed = NO;
    NSWindow *second = [[NSWindow alloc] initWithContentRect:NSMakeRect(100, 100, 200, 100) styleMask:NSWindowStyleMaskBorderless
        backing:NSBackingStoreBuffered defer:NO];
    second.releasedWhenClosed = NO;
    firstWindow = first;
    secondWindow = second;
    surfaceLayoutObserve(^(void *window) { record(@"started", window); }, ^(void *window) {
        record(@"ended", window);
        if ([CATransaction valueForKey:transactionMarker] != nil) endedInOpenTransaction = YES;
    });
    checkStartedPrecedesReady();
    SPHeldPresentation *view = [[[SPHeldPresentation alloc] initWithFrame:NSMakeRect(0, 0, 100, 100)] autorelease];
    [first.contentView addSubview:view];
    checkDeferredCommit(view);
    checkCancel();
    [view removeFromSuperview];
    checkSettledWithBlock(second);
    [first release];
    [second release];
    return failures == 0 ? 0 : 1;
} }
