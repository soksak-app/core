// Checks that a title bar height changed while the layout transaction (surfaceLayoutBegin) of the window is open is taken by
// the window model and that the transaction commits, judged by the layout trace of each transaction: its ticket, its begin
// before the change, its commit after the change, and the time it was sent to the render server. A recording of the window at
// each refresh is evidence of the window buttons on screen and is not judged; a failing check keeps its folder. The check does
// not activate the application.
#import <Cocoa/Cocoa.h>
#import <QuartzCore/QuartzCore.h>
#import "surface_layout.h"
#import "window_controls.h"
#import "capture.h"
#import "support/event_wait.h"
#import "support/temporary_folder.h"

// The number of display refreshes to wait while the transaction is open and after the commit.
static const int kRefreshes = 12;

static int failures = 0;

static void check(BOOL condition, NSString *message) {
    fprintf(condition ? stdout : stderr, "%s: %s\n", condition ? "PASS" : "FAIL", message.UTF8String);
    if (!condition) failures++;
}

// Counts a fixed number of display refreshes.
@interface SPFrames : NSObject
@property int left;
- (void)tick:(CADisplayLink *)link;
@end
@implementation SPFrames
- (void)tick:(CADisplayLink *)link {
    if (--self.left == 0) [link invalidate];
}
@end

// Runs the run loop for count display refreshes. The layout and display cycle of AppKit also runs meanwhile. Returns
// the elapsed time (ms).
static double waitFrames(NSScreen *screen, int count) {
    double start = CACurrentMediaTime() * 1000;
    SPFrames *frames = [[SPFrames new] autorelease];
    frames.left = count;
    [[screen displayLinkWithTarget:frames selector:@selector(tick:)]
        addToRunLoop:NSRunLoop.mainRunLoop forMode:NSRunLoopCommonModes];
    eventWait([NSString stringWithFormat:@"the display refreshes %d times", count], ^BOOL { return frames.left == 0; });
    return CACurrentMediaTime() * 1000 - start;
}

// A window like the windows of both hosts: the title bar is hidden and the content fills the whole window. It has no
// toolbar. The content is painted with one color so that only the buttons remain in a different color.
static NSWindow *hostLikeWindow(void) {
    NSWindow *window = [[[NSWindow alloc] initWithContentRect:NSMakeRect(140, 140, 480, 240)
        styleMask:NSWindowStyleMaskTitled | NSWindowStyleMaskClosable | NSWindowStyleMaskMiniaturizable
            | NSWindowStyleMaskResizable | NSWindowStyleMaskFullSizeContentView
        backing:NSBackingStoreBuffered defer:NO] autorelease];
    [window setReleasedWhenClosed:NO];
    window.animationBehavior = NSWindowAnimationBehaviorNone;
    window.titlebarAppearsTransparent = YES;
    window.titleVisibility = NSWindowTitleHidden;
    NSView *content = [[[NSView alloc] initWithFrame:NSMakeRect(0, 0, 480, 240)] autorelease];
    content.wantsLayer = YES;
    content.layer.backgroundColor = [NSColor colorWithSRGBRed:30.0/255 green:60.0/255 blue:200.0/255 alpha:1].CGColor;
    window.contentView = content;
    return window;
}

static bool setHeight(NSWindow *window, double height) {
    char *failure = NULL;
    bool set = windowSetTitlebarHeight(window, height, &failure);
    if (!set) fprintf(stderr, "windowSetTitlebarHeight(%.1f): %s\n", height, failure);
    free(failure);
    return set;
}

// Model values: the center of the button area of windowControls (pt from the content top), and the model frame and
// presentationLayer frame of the close button layer.
static NSString *modelValues(NSWindow *window) {
    double area[4] = {0, 0, 0, 0};
    windowControls(window, area);
    NSButton *close = [window standardWindowButton:NSWindowCloseButton];
    CALayer *layer = close.layer;
    NSString *layers = @"no layer";
    if (layer) {
        CALayer *shown = layer.presentationLayer;
        layers = [NSString stringWithFormat:@"layer %@, presentation %@", NSStringFromRect(NSRectFromCGRect(layer.frame)),
            shown ? NSStringFromRect(NSRectFromCGRect(shown.frame)) : @"none"];
    }
    return [NSString stringWithFormat:@"title bar %.1f, buttons centre %.2f, close frame %@, %@",
        windowTitlebarHeight(window), area[1] + area[3] / 2, NSStringFromRect(close.frame), layers];
}

static double buttonsCentre(NSWindow *window) {
    double area[4] = {0, 0, 0, 0};
    windowControls(window, area);
    return area[1] + area[3] / 2;
}

// The changed title bar height (height), the time of the change (set) and the commit time (committed), and the button
// center before and after the change (from, to).
typedef struct { double height; double set; double committed; double from; double to; } SPChange;

// Opens a transaction, changes the title bar to to, does not commit during kRefreshes display refreshes, and commits
// afterwards.
static SPChange change(NSWindow *window, uint64_t ticket, double to) {
    SPChange result = { to, 0, 0, buttonsCentre(window), 0 };
    __block BOOL allowed = NO;
    surfaceLayoutTraceStart();
    double began = CACurrentMediaTime() * 1000;
    surfaceLayoutBegin(window, ticket, ^(int ready) { allowed = ready; });
    check(allowed, [NSString stringWithFormat:@"the layout transaction %llu starts", ticket]);
    fprintf(stdout, "model before %.1fpt: %s\n", to, modelValues(window).UTF8String);
    result.set = CACurrentMediaTime() * 1000;
    check(setHeight(window, to), [NSString stringWithFormat:@"the title bar takes %.1fpt inside the open transaction", to]);
    result.to = buttonsCentre(window);
    fprintf(stdout, "model after setting %.1fpt in the open transaction: %s\n", to, modelValues(window).UTF8String);
    double waited = waitFrames(window.screen, kRefreshes);
    fprintf(stdout, "model after %d refreshes (%.1fms) in the open transaction: %s\n",
        kRefreshes, waited, modelValues(window).UTF8String);
    result.committed = CACurrentMediaTime() * 1000;
    check(surfaceLayoutCommit(window, ticket), [NSString stringWithFormat:@"the layout transaction %llu commits", ticket]);
    double returned = CACurrentMediaTime() * 1000;
    waited = waitFrames(window.screen, kRefreshes);
    fprintf(stdout, "model after %d refreshes (%.1fms) after the commit: %s\n",
        kRefreshes, waited, modelValues(window).UTF8String);
    // The refreshes after the commit end after the transaction that carried it reached the render server.
    double ended = CACurrentMediaTime() * 1000;
    double trace[2 * SURFACE_LAYOUT_TRACE_STAGES];
    size_t traced = surfaceLayoutTraceStop(trace, 2);
    check(traced == 1 && trace[0] == ticket && began <= trace[1] && trace[1] <= result.set && result.committed <= trace[3]
            && trace[3] <= returned && trace[5] == SURFACE_LAYOUT_COMMIT_PRESENT,
        [NSString stringWithFormat:@"%.1fpt title bar: the trace records ticket %llu begun before the change and committed by "
            "the host after it (%zu records: ticket %.0f, begun %.3f, set %.3f, committed %.3f within %.3f..%.3f, path %.0f)",
            to, ticket, traced, trace[0], trace[1], result.set, trace[3], result.committed, returned, trace[5]]);
    check(traced == 1 && trace[1] <= trace[7] && trace[7] <= ended,
        [NSString stringWithFormat:@"%.1fpt title bar: the trace records when the commit of ticket %llu was sent to the render "
            "server, before the refreshes after it end (begun %.3f, flushed %.3f, refreshes ended %.3f)", to, ticket, trace[1],
            trace[7], ended]);
    return result;
}

int main(void) { @autoreleasepool {
    [NSApplication sharedApplication];
    [NSApp setActivationPolicy:NSApplicationActivationPolicyProhibited];
    [NSApp finishLaunching];
    [NSApp setActivationPolicy:NSApplicationActivationPolicyAccessory];

    NSWindow *window = hostLikeWindow();
    check(setHeight(window, 40), @"the window starts with a 40pt title bar");
    [window orderFrontRegardless];
    waitFrames(window.screen, kRefreshes);

    NSString *recordingDirectory = temporaryFolder(@"soksak-titlebar-test-");
    const char *directory = recordingDirectory.fileSystemRepresentation;
    char *operationError = NULL;
    BOOL opened = sp_capture_open(window.windowNumber, false, &operationError);
    BOOL started = NO;
    // One still at each refresh of the display, for longer than both changes take: the stop ends the recording.
    if (opened) {
        free(operationError);
        operationError = NULL;
        started = sp_capture_start(directory, 1000.0 / window.screen.maximumFramesPerSecond, 0, 4096, 0, &operationError);
    }
    // The recording is evidence: a recording that does not start or ends with an error is reported and not judged.
    if (!started) fprintf(stdout, "the title bar recording did not start (%s)\n", operationError == NULL ? "" : operationError);
    free(operationError);
    // The heights are the first rows for frame font scales 1 and 2. Raises then lowers.
    change(window, 201, 80);
    change(window, 202, 40);
    if (started) {
        int count = sp_capture_stop(CACurrentMediaTime() * 1000, 0);
        const char *recordingError = sp_capture_error();
        fprintf(stdout, "recording: %d frames, %d late, longest gap %.1fms, error %s\n", count, sp_capture_late(),
            sp_capture_longest_gap(), recordingError[0] ? recordingError : "none");
    }
    if (failures) keepTemporaryFolder(recordingDirectory);
    [window close];
    return failures ? 1 : 0;
}}
