// Checks with a real recording that, when the window grows during a recording, the last frame holds the entire window at device
// pixel resolution: each still takes the window at its size at the request, so no output size is fixed at the start.
// Does not activate the application.
#import "../src/capture.m"
#import "support/run_until.h"
#import "support/temporary_folder.h"

static int failures;
static double resizeRequestedAtMilliseconds;
static void check(BOOL condition, NSString *message) {
    fprintf(condition ? stdout : stderr, "%s: %s\n", condition ? "PASS" : "FAIL", message.UTF8String);
    if (!condition) failures++;
}

// Records the next presentation target time (ms, mach absolute time) at each display link callback of the window screen.
@interface SPPresentation : NSObject
@property (nonatomic) int ticks;
@property (nonatomic) double target;
@end
@implementation SPPresentation
- (void)tick:(CADisplayLink *)link {
    self.ticks++;
    self.target = link.targetTimestamp * 1000;
}
@end

// Runs the run loop until done holds (support/run_until.h).
static void until(NSString *what, BOOL (^done)(void)) {
    sp_run_until(what.UTF8String, done);
}

int main(void) { @autoreleasepool {
    CFTimeInterval began = CACurrentMediaTime();
    fprintf(stderr, "START: native capture follows a growing window\n");
    [NSApplication sharedApplication];
    [NSApp setActivationPolicy:NSApplicationActivationPolicyAccessory];
    [NSApp finishLaunching];
    NSWindow *window = [[[NSWindow alloc] initWithContentRect:NSMakeRect(80, 80, 200, 100)
        styleMask:NSWindowStyleMaskBorderless backing:NSBackingStoreBuffered defer:NO] autorelease];
    [window setReleasedWhenClosed:NO];
    window.animationBehavior = NSWindowAnimationBehaviorNone;
    window.backgroundColor = NSColor.redColor;
    [window orderFrontRegardless];
    BOOL (^onScreen)(void) = ^BOOL {
        NSArray *info = [(NSArray *)CGWindowListCopyWindowInfo(kCGWindowListOptionIncludingWindow,
            (CGWindowID)window.windowNumber) autorelease];
        return info.count == 1 && [info[0][(id)kCGWindowIsOnscreen] boolValue];
    };
    // Does not change the window until the window server has composited its first frame, when its occlusion state becomes
    // visible (same as capture_cycles_test).
    until(@"the window is visible", ^BOOL { return (window.occlusionState & NSWindowOcclusionStateVisible) != 0; });
    check(onScreen(), @"the window server shows the capture window");
    double scale = window.backingScaleFactor;

    // A changed window is committed at the next screen update and presented at the update after that. Returns the target
    // time of the second display link callback (same reference as host.window.presented of the host).
    double (^presentedAfterChange)(void) = ^double {
        SPPresentation *presentation = [[SPPresentation new] autorelease];
        CADisplayLink *link = [window.contentView displayLinkWithTarget:presentation selector:@selector(tick:)];
        [link addToRunLoop:NSRunLoop.currentRunLoop forMode:NSDefaultRunLoopMode];
        until(@"the second display link callback", ^BOOL { return presentation.ticks >= 2; });
        [link invalidate];
        return presentation.target;
    };
    // Checks that the number-th (from 1) frame of a recording, in the file order of its directory, holds the window size points in
    // device pixels. Frames are named by the index of their still, so the file order is the order of the requests.
    BOOL (^frameIs)(NSString *, int, NSSize, NSString *) = ^BOOL(NSString *directory, int number, NSSize points, NSString *label) {
        NSArray *files = [[[[NSFileManager defaultManager] contentsOfDirectoryAtPath:directory error:nil]
            filteredArrayUsingPredicate:[NSPredicate predicateWithBlock:^BOOL(NSString *name, NSDictionary *bindings) {
                (void)bindings;
                return [name hasPrefix:@"frame-"] && [name hasSuffix:@".bgra"];
            }]] sortedArrayUsingSelector:@selector(compare:)];
        NSString *path = number >= 1 && number <= (int)files.count
            ? [directory stringByAppendingPathComponent:files[number - 1]] : nil;
        NSData *stored = path ? [NSData dataWithContentsOfFile:path] : nil;
        if (stored.length < 88) {
            check(NO, [NSString stringWithFormat:@"%@: frame %d has a header", label, number]);
            return NO;
        }
        uint32_t head[3];
        double info[8];
        memcpy(head, stored.bytes, sizeof head);
        memcpy(info, (const uint8_t *)stored.bytes + sizeof head, sizeof info);
        uint32_t width = (uint32_t)llround(points.width * scale), height = (uint32_t)llround(points.height * scale);
        BOOL ok = head[0] == width && head[1] == height && info[4] == 1;
        check(ok, [NSString stringWithFormat:@"%@: frame %d records the window at device pixels "
            "(buffer %ux%u, content %.1fx%.1f at content scale %.4f; expected %ux%u at 1; "
            "still requested at %.3fms and completed at %.3fms, resize requested at %.3fms)",
            label, number, head[0], head[1], info[2], info[3], info[4], width, height, info[6], info[7],
            resizeRequestedAtMilliseconds]);
        return ok;
    };
    // Runs change while recording the window and stops after its presentation. Returns the frame count and leaves the directory in directory.
    int (^record)(NSString *, void (^)(void), NSString **) = ^int(NSString *label, void (^change)(void), NSString **directoryOut) {
        NSString *directory = temporaryFolder(@"soksak-capture-resize-");
        *directoryOut = directory;
        char *operationError = NULL;
        bool opened = sp_capture_open(window.windowNumber, false, &operationError);
        check(opened, [NSString stringWithFormat:@"%@: the window opens for recording (%s)", label, operationError ?: ""]);
        free(operationError); operationError = NULL;
        // One still at each refresh of the display, for as long as the change takes: the stop ends the recording.
        double gap = 1000.0 / window.screen.maximumFramesPerSecond;
        bool recording = opened && sp_capture_start(directory.fileSystemRepresentation, gap, 0, 4096, 0, &operationError);
        check(recording, [NSString stringWithFormat:@"%@: recording starts with its first still (%s)", label, operationError ?: ""]);
        free(operationError);
        if (!recording) return 0;
        SPCaptureRecording *current = nil;
        @synchronized ([SPCaptureRecording class]) { current = [captureRecording retain]; }
        resizeRequestedAtMilliseconds = CACurrentMediaTime() * 1000;
        change();
        [window display];
        int frames = sp_capture_stop(presentedAfterChange(), 0);
        NSString *stopError = [NSString stringWithUTF8String:sp_capture_error()];
        NSData *displayLinkData = [NSData dataWithContentsOfFile:
            [directory stringByAppendingPathComponent:@"display-link.json"]];
        NSDictionary *displayLinkTrace = displayLinkData
            ? [NSJSONSerialization JSONObjectWithData:displayLinkData options:0 error:nil] : nil;
        check([displayLinkTrace[@"state"] isEqual:@"available"]
            && [displayLinkTrace[@"observations"] isKindOfClass:NSArray.class]
            && [displayLinkTrace[@"observations"] count] > 0,
            [NSString stringWithFormat:@"%@ : the visible capture window produces independent AppKit refresh observations", label]);
        check(current.displayLink == nil && current.displayWindow == nil && current.displayLinkStopped,
            [NSString stringWithFormat:@"%@ : stopping the capture invalidates its retained display link", label]);
        [current release];
        check(stopError.length == 0 && frames > 0,
            [NSString stringWithFormat:@"%@: recording stops without error (frames %d, error %@)", label, frames, stopError]);
        return frames;
    };
    // When the window grows during a recording, the last frame after the presentation of the grown window holds the grown window in device pixels.
    NSString *directory = nil;
    int frames = record(@"growing", ^{
        [window setFrame:NSMakeRect(80, 80, 320, 160) display:YES];
        window.backgroundColor = NSColor.blueColor;
    }, &directory);
    if (frames > 0) frameIs(directory, frames, NSMakeSize(320, 160), @"growing");
    NSString *growingDirectory = directory;

    // A new recording of a window shrunk outside a recording has the shrunk window size from the first frame. It does not inherit the output size changed by the previous recording.
    [window setFrame:NSMakeRect(80, 80, 200, 100) display:YES];
    presentedAfterChange();
    directory = nil;
    frames = record(@"after shrinking", ^{ window.backgroundColor = NSColor.greenColor; }, &directory);
    if (frames > 0) {
        frameIs(directory, 1, NSMakeSize(200, 100), @"after shrinking");
        frameIs(directory, frames, NSMakeSize(200, 100), @"after shrinking");
    }
    // A stop on another thread invalidates the display link on the main thread, which keeps running its run loop meanwhile; the
    // stop returns once the link is invalidated.
    SPCaptureRecording *observed = [[SPCaptureRecording alloc] init];
    observed.windowNumber = window.windowNumber;
    [observed startDisplayLinkObservation];
    check(observed.displayLink != nil, @"a visible test window creates an AppKit display link for asynchronous teardown");
    __block BOOL stopped = NO;
    dispatch_async(dispatch_get_global_queue(QOS_CLASS_DEFAULT, 0), ^{
        [observed stopDisplayLinkObservation];
        dispatch_async(dispatch_get_main_queue(), ^{ stopped = YES; });
    });
    until(@"the display link invalidation on the main queue", ^BOOL { return stopped; });
    check(observed.displayLink == nil && observed.displayWindow == nil && observed.displayLinkStopped,
        @"background capture stop completes main-run-loop display-link invalidation without blocking the window thread");
    [observed release];
    check(!NSApp.isActive, @"recording does not activate the application");
    [window close];
    // The frames, stills.jsonl and the display link trace of both recordings are the evidence of a failure.
    if (failures) {
        if (growingDirectory) keepTemporaryFolder(growingDirectory);
        if (directory) keepTemporaryFolder(directory);
    }
    fprintf(stderr, "%s: native capture follows a growing window (%.1fms)\n", failures ? "FAIL" : "PASS",
        (CACurrentMediaTime() - began) * 1000);
    return failures ? 1 : 0;
}}
