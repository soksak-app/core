// Checks that a title bar height changed while the layout transaction (surfaceLayoutBegin) of the window is open is taken by
// the window model and that the transaction commits. A recording of the window at each refresh keeps every still with a complete
// frame file and holds stills taken while each transaction is open and after its commit; the frames are evidence of the window
// buttons on screen and their pixels are not judged. The check does not activate the application.
#import <Cocoa/Cocoa.h>
#import <QuartzCore/QuartzCore.h>
#import "surface_layout.h"
#import "window_controls.h"
#import "capture.h"
#import "support/capture_frame.m"
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
    waited = waitFrames(window.screen, kRefreshes);
    fprintf(stdout, "model after %d refreshes (%.1fms) after the commit: %s\n",
        kRefreshes, waited, modelValues(window).UTF8String);
    return result;
}

// Checks the recording frames at every change, in request order: every still has a complete frame file, and for every change
// the recording has stills requested after the change and completed before the commit, and stills requested after the commit.
// The pixels are evidence and are not judged.
static void judge(NSString *directory, int count, const SPChange *changes, int total) {
    double requested[count], completed[count];
    int unreadable = 0;
    for (int index = 0; index < count; index++) {
        NSString *path = [directory stringByAppendingPathComponent:
            [NSString stringWithFormat:@"frame-%04d.bgra", index]];
        NSData *data = readCaptureFrame([NSData dataWithContentsOfFile:path]);
        double info[8] = {0};
        requested[index] = completed[index] = NAN;
        if (data == nil) { unreadable++; continue; }
        [data getBytes:info range:NSMakeRange(3 * sizeof(uint32_t), sizeof(info))];
        requested[index] = info[6];
        completed[index] = info[7];
    }
    check(unreadable == 0, [NSString stringWithFormat:@"every still of the recording has a complete frame file (%d of %d do not)",
        unreadable, count]);
    for (int c = 0; c < total; c++) {
        const SPChange *at = &changes[c];
        double next = c + 1 < total ? changes[c + 1].set : INFINITY;
        int held = 0, after = 0;
        for (int index = 0; index < count; index++) {
            if (requested[index] >= at->set && completed[index] < at->committed) held++;
            else if (requested[index] >= at->committed && requested[index] < next) after++;
        }
        fprintf(stdout, "%.1fpt title bar: %d frames between the change and the commit, %d frames after the commit\n",
            at->height, held, after);
        check(held > 0, [NSString stringWithFormat:@"%.1fpt title bar: the recording has frames taken while the "
            "transaction is open (%d)", at->height, held]);
        check(after > 0, [NSString stringWithFormat:@"%.1fpt title bar: the recording has frames taken after the commit (%d)",
            at->height, after]);
    }
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
        started = sp_capture_start(directory, 1000.0 / window.screen.maximumFramesPerSecond, 0, 4096, false, 0, &operationError);
    }
    check(started, [NSString stringWithFormat:@"the title bar recording starts with its initial frame (%s)",
        operationError == NULL ? "" : operationError]);
    free(operationError);
    if (started) {
        // The heights are the first rows for frame font scales 1 and 2. Raises then lowers.
        SPChange changes[2];
        changes[0] = change(window, 201, 80);
        changes[1] = change(window, 202, 40);
        int count = sp_capture_stop(CACurrentMediaTime() * 1000, 0);
        const char *recordingError = sp_capture_error();
        check(recordingError[0] == 0, [NSString stringWithFormat:
            @"the title bar recording ends without error or a failed still (%s)", recordingError[0] ? recordingError : "none"]);
        check(count >= 3, [NSString stringWithFormat:@"the title bar recording has frames for both changes (%d)", count]);
        fprintf(stdout, "recording: %d frames, %d late, longest gap %.1fms\n", count, sp_capture_late(), sp_capture_longest_gap());
        judge(recordingDirectory, count, changes, 2);
    }
    if (failures) keepTemporaryFolder(recordingDirectory);
    [window close];
    return failures ? 1 : 0;
}}
