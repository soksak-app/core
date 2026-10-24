// Checks with a real stream that, when the window grows during a recording, the last frame holds the entire window at device pixel resolution.
// The stream output size is fixed at start; if it is not followed, the enlarged window is recorded scaled down.
// Does not activate the application.
#import "../src/capture.m"

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

static void spin(NSTimeInterval seconds) {
    NSDate *until = [NSDate dateWithTimeIntervalSinceNow:seconds];
    while (until.timeIntervalSinceNow > 0) {
        [[NSRunLoop currentRunLoop] runMode:NSDefaultRunLoopMode beforeDate:
            [NSDate dateWithTimeIntervalSinceNow:MIN(0.01, until.timeIntervalSinceNow)]];
    }
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
    NSDate *deadline = [NSDate dateWithTimeIntervalSinceNow:10];
    while (!onScreen() && deadline.timeIntervalSinceNow > 0) spin(0.01);
    check(onScreen(), @"the window server shows the capture window");
    // Does not change the window until the first composited frame is stable (same as capture_cycles_test).
    spin(3);
    double scale = window.backingScaleFactor;

    // A changed window is committed at the next screen update and presented at the update after that. Returns the target
    // time of the second display link callback (same reference as host.window.presented of the host).
    double (^presentedAfterChange)(void) = ^double {
        SPPresentation *presentation = [[SPPresentation new] autorelease];
        CADisplayLink *link = [window.contentView displayLinkWithTarget:presentation selector:@selector(tick:)];
        [link addToRunLoop:NSRunLoop.currentRunLoop forMode:NSDefaultRunLoopMode];
        NSDate *presented = [NSDate dateWithTimeIntervalSinceNow:10];
        while (presentation.ticks < 2 && presented.timeIntervalSinceNow > 0) spin(0.005);
        [link invalidate];
        check(presentation.ticks >= 2, [NSString stringWithFormat:@"the display link reports the next presentation (%d ticks)", presentation.ticks]);
        return presentation.target;
    };
    // Checks that the index-th (from 1) frame of a recording holds the window size points in device pixels. Frame numbers continue
    // across recordings, so the frame is chosen by the file order of the directory.
    BOOL (^frameIs)(NSString *, int, NSSize, NSString *) = ^BOOL(NSString *directory, int number, NSSize points, NSString *label) {
        NSArray *files = [[[[NSFileManager defaultManager] contentsOfDirectoryAtPath:directory error:nil]
            filteredArrayUsingPredicate:[NSPredicate predicateWithBlock:^BOOL(NSString *name, NSDictionary *bindings) {
                (void)bindings;
                return [name hasPrefix:@"frame-"] && [name hasSuffix:@".bgra"];
            }]] sortedArrayUsingSelector:@selector(compare:)];
        NSString *path = number >= 1 && number <= (int)files.count
            ? [directory stringByAppendingPathComponent:files[number - 1]] : nil;
        NSData *stored = path ? [NSData dataWithContentsOfFile:path] : nil;
        if (stored.length < 68) {
            check(NO, [NSString stringWithFormat:@"%@: frame %d has a header", label, number]);
            return NO;
        }
        uint32_t head[3];
        double info[7];
        memcpy(head, stored.bytes, sizeof head);
        memcpy(info, (const uint8_t *)stored.bytes + sizeof head, sizeof info);
        uint32_t width = (uint32_t)llround(points.width * scale), height = (uint32_t)llround(points.height * scale);
        BOOL ok = head[0] == width && head[1] == height && info[4] == 1;
        check(ok, [NSString stringWithFormat:@"%@: frame %d records the window at device pixels "
            "(buffer %ux%u, content %.1fx%.1f at content scale %.4f; expected %ux%u at 1; "
            "frame displayed at %.3fms, resize requested at %.3fms)",
            label, number, head[0], head[1], info[2], info[3], info[4], width, height, info[6], resizeRequestedAtMilliseconds]);
        return ok;
    };
    // Runs change while recording the window and stops after its presentation. Returns the frame count and leaves the directory in directory.
    int (^record)(NSString *, void (^)(void), NSString **) = ^int(NSString *label, void (^change)(void), NSString **directoryOut) {
        char template[] = "/tmp/soksak-capture-resize-XXXXXX";
        if (mkdtemp(template) == NULL) { check(NO, [NSString stringWithFormat:@"%@: the capture directory is created", label]); return 0; }
        NSString *directory = [NSString stringWithUTF8String:template];
        *directoryOut = directory;
        char *operationError = NULL;
        bool opened = sp_capture_open(window.windowNumber, false, &operationError);
        check(opened, [NSString stringWithFormat:@"%@: the window opens for recording (%s)", label, operationError ?: ""]);
        free(operationError); operationError = NULL;
        bool recording = opened && sp_capture_start(directory.fileSystemRepresentation, &operationError);
        check(recording, [NSString stringWithFormat:@"%@: recording starts (%s)", label, operationError ?: ""]);
        free(operationError);
        if (!recording) return 0;
        check(sp_capture_wait() == 1, [NSString stringWithFormat:@"%@: a first frame arrives (%s)", label, sp_capture_error()]);
        resizeRequestedAtMilliseconds = CACurrentMediaTime() * 1000;
        change();
        [window display];
        int frames = sp_capture_stop(presentedAfterChange());
        NSString *stopError = [NSString stringWithUTF8String:sp_capture_error()];
        NSData *displayLinkData = [NSData dataWithContentsOfFile:
            [directory stringByAppendingPathComponent:@"display-link.json"]];
        NSDictionary *displayLinkTrace = displayLinkData
            ? [NSJSONSerialization JSONObjectWithData:displayLinkData options:0 error:nil] : nil;
        check([displayLinkTrace[@"state"] isEqual:@"available"]
            && [displayLinkTrace[@"observations"] isKindOfClass:NSArray.class]
            && [displayLinkTrace[@"observations"] count] > 0,
            [NSString stringWithFormat:@"%@ : the visible capture window produces independent AppKit refresh observations", label]);
        check(captureSink.displayLink == nil && captureSink.displayLinkStopped && captureSink.displayLinkInvalidated,
            [NSString stringWithFormat:@"%@ : stopping the capture invalidates its retained display link", label]);
        check(stopError.length == 0 && frames > 0,
            [NSString stringWithFormat:@"%@: recording stops without error (frames %d, error %@)", label, frames, stopError]);
        return frames;
    };
    void (^remove)(NSString *) = ^(NSString *directory) {
        if (failures != 0 && directory != nil) {
            fprintf(stderr, "RETAIN capture evidence: %s\n", directory.UTF8String);
            return;
        }
        NSError *removal = nil;
        check(directory == nil || [[NSFileManager defaultManager] removeItemAtPath:directory error:&removal],
            [NSString stringWithFormat:@"capture files are removed (%@)", removal]);
    };

    // When the window grows during a recording, the last frame after the presentation of the grown window holds the grown window in device pixels.
    NSString *directory = nil;
    int frames = record(@"growing", ^{
        [window setFrame:NSMakeRect(80, 80, 320, 160) display:YES];
        window.backgroundColor = NSColor.blueColor;
    }, &directory);
    if (frames > 0) frameIs(directory, frames, NSMakeSize(320, 160), @"growing");
    remove(directory);

    // A new recording of a window shrunk outside a recording has the shrunk window size from the first frame. It does not inherit the output size changed by the previous recording.
    [window setFrame:NSMakeRect(80, 80, 200, 100) display:YES];
    presentedAfterChange();
    directory = nil;
    frames = record(@"after shrinking", ^{ window.backgroundColor = NSColor.greenColor; }, &directory);
    if (frames > 0) {
        frameIs(directory, 1, NSMakeSize(200, 100), @"after shrinking");
        frameIs(directory, frames, NSMakeSize(200, 100), @"after shrinking");
    }
    remove(directory);
    [captureSink startDisplayLinkObservationForWindowNumber:window.windowNumber];
    check(captureSink.displayLink != nil, @"a visible test window creates an AppKit display link for asynchronous teardown");
    SPCapture *asyncStopSink = [captureSink retain];
    dispatch_async(dispatch_get_global_queue(DISPATCH_QUEUE_PRIORITY_DEFAULT, 0), ^{
        [asyncStopSink stopDisplayLinkObservation];
        [asyncStopSink release];
    });
    NSDate *invalidationDeadline = [NSDate dateWithTimeIntervalSinceNow:2];
    while (!captureSink.displayLinkInvalidated && invalidationDeadline.timeIntervalSinceNow > 0) spin(0.005);
    check(captureSink.displayLink == nil && captureSink.displayLinkStopped && captureSink.displayLinkInvalidated,
        @"background capture stop completes main-run-loop display-link invalidation without blocking the window thread");
    check(!NSApp.isActive, @"recording does not activate the application");
    [window close];
    fprintf(stderr, "%s: native capture follows a growing window (%.1fms)\n", failures ? "FAIL" : "PASS",
        (CACurrentMediaTime() - began) * 1000);
    return failures ? 1 : 0;
}}
