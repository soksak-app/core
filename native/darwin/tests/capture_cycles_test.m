// Starts and stops the recording of an inactive window repeatedly in one process. The window check stops the
// recording of each theme as soon as it starts, so this creates a sequence that an acceptance check running
// only one cycle cannot create. It does not change the actual API results and records the start, stop, and
// delegate callbacks. It does not activate the application.
#import "../src/capture.m"
#import <objc/runtime.h>

static const int CYCLES = 24;
static IMP originalStart, originalStop, originalDelegate;
static unsigned starts, stops, delegateStops;
static CFTimeInterval began;
static int failures;

static void record(NSString *event, id stream, NSError *error) {
    @synchronized([SPCapture class]) {
        fprintf(stderr, "LIFECYCLE +%.3fms %s stream=%p current=%d error-domain=%s error-code=%ld error=%s\n",
            (CACurrentMediaTime() - began) * 1000, event.UTF8String, stream, stream == captureStream,
            error == nil ? "none" : error.domain.UTF8String, (long)error.code,
            error == nil ? "none" : error.localizedDescription.UTF8String);
    }
}

static void start(id stream, SEL selector, void (^completion)(NSError *)) {
    starts++; record(@"start-request", stream, nil);
    ((void (*)(id, SEL, void (^)(NSError *)))originalStart)(stream, selector, ^(NSError *error) {
        record(@"start-completion", stream, error); completion(error);
    });
}

static void stop(id stream, SEL selector, void (^completion)(NSError *)) {
    stops++; record(@"stop-request", stream, nil);
    ((void (*)(id, SEL, void (^)(NSError *)))originalStop)(stream, selector, ^(NSError *error) {
        record(@"stop-completion", stream, error); completion(error);
    });
}

static void delegateStop(id sink, SEL selector, SCStream *stream, NSError *error) {
    delegateStops++; record(@"delegate-stop", stream, error);
    ((void (*)(id, SEL, SCStream *, NSError *))originalDelegate)(sink, selector, stream, error);
}

static void check(BOOL condition, NSString *message) {
    fprintf(condition ? stdout : stderr, "%s: %s\n", condition ? "PASS" : "FAIL", message.UTF8String);
    if (!condition) failures++;
}

int main(void) { @autoreleasepool {
    began = CACurrentMediaTime();
    [NSApplication sharedApplication];
    [NSApp setActivationPolicy:NSApplicationActivationPolicyAccessory];
    [NSApp finishLaunching];
    Method startMethod = class_getInstanceMethod([SCStream class], @selector(startCaptureWithCompletionHandler:));
    Method stopMethod = class_getInstanceMethod([SCStream class], @selector(stopCaptureWithCompletionHandler:));
    Method delegateMethod = class_getInstanceMethod([SPCapture class], @selector(stream:didStopWithError:));
    if (startMethod == NULL || stopMethod == NULL || delegateMethod == NULL) {
        fprintf(stderr, "FAIL: capture lifecycle methods are unavailable\n"); return 1;
    }
    originalStart = method_setImplementation(startMethod, (IMP)start);
    originalStop = method_setImplementation(stopMethod, (IMP)stop);
    originalDelegate = method_setImplementation(delegateMethod, (IMP)delegateStop);

    NSWindow *window = [[NSWindow alloc] initWithContentRect:NSMakeRect(80, 80, 200, 100)
        styleMask:NSWindowStyleMaskBorderless backing:NSBackingStoreBuffered defer:NO];
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
    while (!onScreen() && deadline.timeIntervalSinceNow > 0) {
        [[NSRunLoop currentRunLoop] runMode:NSDefaultRunLoopMode beforeDate:[NSDate dateWithTimeIntervalSinceNow:0.01]];
    }
    check(onScreen(), @"the window server shows the capture window");
    // As in the acceptance check, do not change the window until the first composited frame is stable.
    NSDate *settled = [NSDate dateWithTimeIntervalSinceNow:3];
    while (settled.timeIntervalSinceNow > 0) {
        [[NSRunLoop currentRunLoop] runMode:NSDefaultRunLoopMode beforeDate:
            [NSDate dateWithTimeIntervalSinceNow:MIN(0.01, settled.timeIntervalSinceNow)]];
    }

    NSArray<NSColor *> *colors = @[NSColor.redColor, NSColor.blueColor, NSColor.greenColor];
    int completed = 0;
    for (int cycle = 1; cycle <= CYCLES && failures == 0; cycle++) {
        // As in the window check, change the window content each cycle.
        window.backgroundColor = colors[cycle % colors.count];
        [window display];
        char template[] = "/tmp/soksak-capture-cycles-XXXXXX";
        if (mkdtemp(template) == NULL) { check(NO, [NSString stringWithFormat:@"cycle %d creates a capture directory", cycle]); break; }
        NSString *directory = [NSString stringWithUTF8String:template];
        char *operationError = NULL;
        bool opened = sp_capture_open(window.windowNumber, false, &operationError);
        check(opened, [NSString stringWithFormat:@"cycle %d opens the window for recording (%s)", cycle,
            operationError == NULL ? "" : operationError]);
        free(operationError); operationError = NULL;
        if (!opened) break;
        bool recording = sp_capture_start(directory.fileSystemRepresentation, &operationError);
        check(recording, [NSString stringWithFormat:@"cycle %d starts recording (%s)", cycle,
            operationError == NULL ? "" : operationError]);
        free(operationError);
        if (recording) {
            int first = sp_capture_wait();
            check(first == 1, [NSString stringWithFormat:@"cycle %d produces a first frame (%s)", cycle, sp_capture_error()]);
            int frames = sp_capture_stop(0);
            // The error string is shared state, so use the same copy for the verdict and the report.
            const char *stopError = sp_capture_error();
            NSString *stopText = stopError == NULL ? nil : [NSString stringWithUTF8String:stopError];
            check(stopText != nil && stopText.length == 0 && frames > 0,
                [NSString stringWithFormat:@"cycle %d stops without error (frames %d, error %@)", cycle, frames, stopText]);
            if (failures == 0) completed++;
        }
        NSError *removeError = nil;
        if ([[NSFileManager defaultManager] fileExistsAtPath:directory]
            && ![[NSFileManager defaultManager] removeItemAtPath:directory error:&removeError]) {
            check(NO, [NSString stringWithFormat:@"cycle %d removes its frames (%@)", cycle, removeError]);
        }
    }
    method_setImplementation(startMethod, originalStart);
    method_setImplementation(stopMethod, originalStop);
    method_setImplementation(delegateMethod, originalDelegate);
    check(!NSApp.isActive, @"recording cycles do not activate the application");
    [window close];
    [window release];
    fprintf(stderr, "%s: %d of %d consecutive recording cycles (start=%u stop=%u delegate=%u, %.1fms)\n",
        failures ? "FAIL" : "PASS", completed, CYCLES, starts, stops, delegateStops, (CACurrentMediaTime() - began) * 1000);
    return failures ? 1 : 0;
}}
