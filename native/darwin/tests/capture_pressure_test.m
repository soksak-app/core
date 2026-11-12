// Injects writer capacity, window server and file write faults into the real still recording, and checks the ends of its waits.
// A full writer fails the still without holding its request; the last still of the largest plan is written; a still 0 without an
// image fails the start; the end of a wait from another thread ends the wait of its token only; the close of the recorded window
// ends a stop while the main thread stays free; a scheduled stop answers its context once when another window's close ends its
// wait; a request during a recording keeps the recording, its error and its prepared
// window; a still request fails with its own error; and a stop keeps the earlier write error of the recording with its own.
// Capture internal state is read only by the ownership checks.
#import "../src/capture.m"
#import "../src/host_api_capture.m"
#import "support/run_until.h"
#import "support/temporary_folder.h"
#include <stdatomic.h>

static int failures;
static void check(BOOL ok, NSString *label) {
    fprintf(ok ? stdout : stderr, "%s: %s\n", ok ? "PASS" : "FAIL", label.UTF8String);
    if (!ok) failures++;
}

// The worker and the main-thread function of a host: on another thread both run the block directly (main_thread.h).
static void directly(void (^work)(void)) { work(); }
#define STUB_V(result, name, parameters) static result stub_##name parameters {}
#define STUB(mode, result, name, parameters, arguments) STUB_##mode(result, name, parameters)
SP_HOST_DIAGNOSTIC_CALLBACKS(STUB)

// The answers of the scheduled capture calls, which reach the main thread as events.
static int captureAnswers;
static uintptr_t captureAnswerContext;
static long captureAnswerResult;
static char *captureAnswerFailure;
static void captureAnswered(uintptr_t context, long result, char *failure) {
    char *copied = failure ? strdup(failure) : NULL;
    dispatch_async(dispatch_get_main_queue(), ^{
        captureAnswerContext = context;
        captureAnswerResult = result;
        free(captureAnswerFailure);
        captureAnswerFailure = copied;
        captureAnswers++;
    });
}

// The window server of the test: an opaque image of the device-pixel size of the window, or no image.
static size_t imageWidth, imageHeight;
static atomic_bool noImage;
static CGImageRef testWindowImage(CGRect rect, CFArrayRef windows, CGWindowImageOption options) {
    (void)rect; (void)windows; (void)options;
    if (atomic_load(&noImage)) return NULL;
    CGColorSpaceRef srgb = CGColorSpaceCreateWithName(kCGColorSpaceSRGB);
    CGContextRef context = CGBitmapContextCreate(NULL, imageWidth, imageHeight, 8, 0, srgb,
        (CGBitmapInfo)kCGImageAlphaPremultipliedFirst | kCGBitmapByteOrder32Little);
    CGColorSpaceRelease(srgb);
    if (context == NULL) return NULL;
    CGContextSetRGBFillColor(context, 0.8, 0.2, 0.2, 1);
    CGContextFillRect(context, CGRectMake(0, 0, imageWidth, imageHeight));
    CGImageRef made = CGBitmapContextCreateImage(context);
    CGContextRelease(context);
    return made;
}
static void *lookupTestWindowImage(void *handle, const char *name) {
    return strcmp(name, "CGWindowListCreateImageFromArray") == 0 ? (void *)testWindowImage : dlsym(handle, name);
}

static NSWindow *makeWindow(void) {
    NSWindow *window = [[NSWindow alloc] initWithContentRect:NSMakeRect(140, 140, 60, 40)
        styleMask:NSWindowStyleMaskBorderless backing:NSBackingStoreBuffered defer:NO];
    window.releasedWhenClosed = NO;
    window.animationBehavior = NSWindowAnimationBehaviorNone;
    // AppKit keeps the order in the open Core Animation transaction of the thread until the run loop commits it, so the test
    // commits it, and the window server lists the window once the commit returns.
    [window orderBack:nil];
    [CATransaction flush];
    return window;
}

static NSString *folder(NSString *root, NSString *name) {
    NSString *path = [root stringByAppendingPathComponent:name];
    [NSFileManager.defaultManager createDirectoryAtPath:path withIntermediateDirectories:NO attributes:nil error:NULL];
    return path;
}

// A recording of window into directory with a plan of frames stills every gap ms; false and the error when it does not start.
static bool startRecording(NSWindow *window, NSString *directory, double gap, int frames, uint64_t token) {
    char *error = NULL;
    bool started = sp_capture_open(window.windowNumber, false, &error)
        && sp_capture_start(directory.fileSystemRepresentation, gap, 0, frames, token, &error);
    if (!started) fprintf(stderr, "the fixture recording did not start: %s\n", error ?: "");
    free(error);
    return started;
}

// A recording whose rows the test fills: the still path from the image to the frame writer runs without a window.
static SPCaptureRecording *rowsRecording(NSString *directory, NSUInteger planned) {
    SPCaptureRecording *recording = [[[SPCaptureRecording alloc] init] autorelease];
    mach_timebase_info_data_t timebase;
    mach_timebase_info(&timebase);
    recording.directory = directory;
    recording.windowNumber = 1;
    recording.planned = planned;
    recording.timebase = timebase;
    for (NSUInteger index = 0; index < planned; index++) [recording.rows addObject:[NSMutableDictionary dictionaryWithDictionary:@{
        @"index": @(index), @"outcome": @"not-requested", @"error": NSNull.null, @"frame": NSNull.null }]];
    recording.nextIndex = planned;
    return recording;
}

// Runs the blocks queued on the main queue before this call.
static void drainMainQueue(void) {
    dispatch_async(dispatch_get_main_queue(), ^{ CFRunLoopStop(CFRunLoopGetMain()); });
    CFRunLoopRun();
}

static NSString *errorText(void) { return [NSString stringWithUTF8String:sp_capture_error()] ?: @""; }

int main(void) { @autoreleasepool {
    CFTimeInterval began = CACurrentMediaTime();
    fprintf(stderr, "START: capture pressure and still-result isolation\n");
    [NSApplication sharedApplication];
    [NSApp setActivationPolicy:NSApplicationActivationPolicyAccessory];
    [NSApp finishLaunching];
    NSString *root = temporaryFolder(@"soksak-capture-pressure-");
    prepareCaptureQueues();
    dispatch_semaphore_t realPending = capturePending;

    // The still path from the image to the frame writer, with controlled writer capacity.
    SPCaptureTarget *target = [[[SPCaptureTarget alloc] init] autorelease];
    target.screen = CGRectMake(0, 0, 4, 4);
    imageWidth = 4; imageHeight = 4;
    CGImageRef image = testWindowImage(CGRectNull, NULL, 0);
    check(image != NULL, @"the controlled still has an image");
    NSString *exhausted = folder(root, @"exhausted");
    SPCaptureRecording *recording = rowsRecording(exhausted, 1);
    clearCaptureError();
    capturePending = dispatch_semaphore_create(0);
    // The still runs on this thread: a still that waited for writer capacity would hold it here, and the check after it is
    // reached by the return of the still.
    bool returned = false;
    processStill(recording, 0, target, image, mach_absolute_time(), mach_absolute_time());
    returned = true;
    check(returned, @"exhausted writer capacity never blocks the still");
    dispatch_sync(captureWriter, ^{});
    check([recording.rows[0][@"outcome"] isEqual:@"failed"]
        && [recording.rows[0][@"error"] isEqual:@"capture pending writer capacity exceeded (64 frames)"],
        [NSString stringWithFormat:@"exhausted writer capacity fails the still with its reason (%@)", recording.rows[0]]);
    check(strstr(sp_capture_error(), "pending writer capacity exceeded") != NULL,
        @"exhausted writer capacity reports an explicit recording error");
    check(recording.written == 0 && ![NSFileManager.defaultManager fileExistsAtPath:
        [exhausted stringByAppendingPathComponent:@"frame-0000.bgra"]], @"an exhausted writer writes no frame for the still");
    dispatch_release(capturePending);

    capturePending = dispatch_semaphore_create(1);
    NSString *available = folder(root, @"available");
    recording = rowsRecording(available, 4096);
    clearCaptureError();
    processStill(recording, 0, target, image, mach_absolute_time(), mach_absolute_time());
    dispatch_sync(captureWriter, ^{});
    check(strlen(sp_capture_error()) == 0 && recording.written == 1 && [recording.rows[0][@"outcome"] isEqual:@"written"],
        @"available writer capacity writes the still");
    processStill(recording, 4095, target, image, mach_absolute_time(), mach_absolute_time());
    dispatch_sync(captureWriter, ^{});
    check(strlen(sp_capture_error()) == 0 && recording.written == 2 && [recording.rows[4095][@"frame"] isEqual:@"frame-4095.bgra"]
        && [NSFileManager.defaultManager fileExistsAtPath:[available stringByAppendingPathComponent:@"frame-4095.bgra"]],
        @"the last still of a plan of 4096 is written under its index");
    dispatch_release(capturePending);
    capturePending = realPending;
    CGImageRelease(image);

    // The recordings of a window through the window server of the test.
    NSWindow *window = makeWindow();
    imageWidth = (size_t)(60 * window.backingScaleFactor);
    imageHeight = (size_t)(40 * window.backingScaleFactor);
    captureLookup = lookupTestWindowImage;

    atomic_store(&noImage, true);
    char *operationError = NULL;
    check(sp_capture_open(window.windowNumber, false, &operationError), @"the window opens for a recording without images");
    free(operationError); operationError = NULL;
    NSString *imageless = folder(root, @"imageless");
    bool imagelessStarted = sp_capture_start(imageless.fileSystemRepresentation, 10, 0, 4, 1, &operationError);
    NSString *want = [NSString stringWithFormat:@"the window server gave no image of window %ld", (long)window.windowNumber];
    check(!imagelessStarted && operationError != NULL && strstr(operationError, want.UTF8String) != NULL,
        [NSString stringWithFormat:@"a still 0 without an image fails the start with its reason (%s)", operationError ?: ""]);
    free(operationError); operationError = NULL;
    check(!recordingActive(), @"a failed start leaves no recording");
    NSString *imagelessRows = [NSString stringWithContentsOfFile:[imageless stringByAppendingPathComponent:@"stills.jsonl"]
        encoding:NSUTF8StringEncoding error:NULL];
    check([imagelessRows containsString:@"\"outcome\":\"failed\""] && [imagelessRows containsString:want],
        @"the failed start records its failed still 0 in stills.jsonl");
    atomic_store(&noImage, false);

    fprintf(stderr, "START: the ends of the capture waits\n");
    // A stop that waits for a still after the plan's last request: the end from another thread ends the wait, whether it comes
    // before or while the wait holds this thread.
    if (startRecording(window, folder(root, @"ended"), 10, 4096, 9)) {
        dispatch_async(dispatch_get_global_queue(QOS_CLASS_USER_INITIATED, 0), ^{
            sp_capture_end_wait(10, "the endpoint connection of the request closed");
        });
        int written = sp_capture_stop(sp_capture_clock() + 3600000, 10);
        check(written > 0 && [errorText() isEqual:
            @"no still was requested at the requested time before the endpoint connection of the request closed"],
            [NSString stringWithFormat:@"an end from another thread ends the wait of the stop (%@)", errorText()]);
    }
    // The end of a returned call changes no later call: the later call waits for its own still.
    sp_capture_end_wait(10, "the window closed");
    if (startRecording(window, folder(root, @"later"), 10, 4096, 11)) {
        int written = sp_capture_stop(sp_capture_clock() + 30, 12);
        check(written > 0 && strlen(sp_capture_error()) == 0,
            [NSString stringWithFormat:@"the end of a returned call does not end a later wait (%@)", errorText()]);
    }
    // A still that came before the end is taken: the wait whose event came is not ended.
    if (startRecording(window, folder(root, @"came"), 10, 4096, 13)) {
        double after = sp_capture_clock();
        sp_run_until("a still is requested after the stop time", ^BOOL {
            SPCaptureRecording *current = nil;
            @synchronized ([SPCaptureRecording class]) { current = captureRecording; }
            mach_timebase_info_data_t timebase = current.timebase;
            uint64_t afterTicks = (uint64_t)(after * 1e6 * timebase.denom / timebase.numer);
            @synchronized (current) {
                for (NSDictionary *row in current.rows) {
                    if ([row[@"completed"] isKindOfClass:NSString.class]
                        && strtoull([row[@"requested"] UTF8String], NULL, 10) >= afterTicks) return YES;
                }
            }
            return NO;
        });
        sp_capture_end_wait(14, "the page of the window ended");
        int written = sp_capture_stop(after, 14);
        check(written > 0 && strlen(sp_capture_error()) == 0,
            [NSString stringWithFormat:@"a still that came before the end answers the wait (%@)", errorText()]);
    }
    // The end of another token leaves the wait to its own event.
    if (startRecording(window, folder(root, @"other"), 10, 4096, 15)) {
        sp_capture_end_wait(17, "the window closed");
        int written = sp_capture_stop(sp_capture_clock() + 30, 16);
        check(written > 0 && strlen(sp_capture_error()) == 0,
            [NSString stringWithFormat:@"the end of another call does not end this wait (%@)", errorText()]);
    }
    // A plan that ends before a still is requested at or after the stop time is an error of the stop.
    if (startRecording(window, folder(root, @"short"), 10, 3, 18)) {
        double after = sp_capture_clock() + 3600000;
        int written = sp_capture_stop(after, 19);
        check(written == 3 && [errorText() hasPrefix:@"the recording ended at "]
            && [errorText() containsString:[NSString stringWithFormat:@", before the requested time %.3f ms", after]],
            [NSString stringWithFormat:@"a plan that ends before the stop time fails the stop (%d, %@)", written, errorText()]);
    }

    // A stop that waits off the main thread leaves the main thread free: while it waits for a still that the plan has not
    // reached, the main thread closes the recorded window, and the close ends the stop.
    NSWindow *closing = makeWindow();
    if (startRecording(closing, folder(root, @"closing"), 10, 4096, 20)) {
        long number = closing.windowNumber;
        __block bool closedOnMain = false, stopped = false;
        __block int written = -1;
        dispatch_async(dispatch_get_global_queue(QOS_CLASS_USER_INITIATED, 0), ^{
            int count = sp_capture_stop(sp_capture_clock() + 3600000, 21);
            dispatch_async(dispatch_get_main_queue(), ^{ written = count; stopped = true; });
        });
        SPCaptureRecording *current = nil;
        @synchronized ([SPCaptureRecording class]) { current = [captureRecording retain]; }
        sp_run_until("the stop waits for its still", ^BOOL {
            @synchronized (current) { return current.stopArmed; }
        });
        [current release];
        closedOnMain = NSThread.isMainThread && !stopped;
        [closing close];
        sp_run_until("the stop ends by the close of the window", ^BOOL { return stopped; });
        NSString *closed = [NSString stringWithFormat:@"the recorded window %ld closed", number];
        check(closedOnMain, @"the main thread closes the window while the stop waits");
        check(written > 0 && [errorText() containsString:closed] && ![errorText() containsString:@"the recording ended at"],
            [NSString stringWithFormat:@"the close of the window ends the stop with its reason (%d, %@)", written, errorText()]);
        check(sp_capture_missed() > 0 && sp_capture_missed() == 4096 - written,
            [NSString stringWithFormat:@"the stills after the close are missed (%d)", sp_capture_missed()]);
    }
    [closing release];
    // The start waits for still 0 to be written, and an end of its token ends that wait: the start fails with the end, and the
    // recording ends with it. A block holds the writer, so still 0 is not written before the end; the end comes before the start
    // waits, which ends the wait when it begins. The start runs off the main thread, as a host runs it, and the main thread
    // releases the writer once the ended recording closed its requests.
    NSWindow *pending = makeWindow();
    if (sp_capture_open(pending.windowNumber, false, &operationError)) {
        dispatch_semaphore_t held = dispatch_semaphore_create(0);
        dispatch_async(captureWriter, ^{ dispatch_semaphore_wait(held, DISPATCH_TIME_FOREVER); });
        sp_capture_end_wait(24, "the endpoint connection of the request closed");
        __block bool startReturned = false, started = true;
        __block char *startError = NULL;
        NSString *pendingFolder = folder(root, @"pending");
        dispatch_async(dispatch_get_global_queue(QOS_CLASS_USER_INITIATED, 0), ^{
            char *failure = NULL;
            bool result = sp_capture_start(pendingFolder.fileSystemRepresentation, 10, 0, 4096, 24, &failure);
            dispatch_async(dispatch_get_main_queue(), ^{ started = result; startError = failure; startReturned = true; });
        });
        sp_run_until("the ended start closes the requests of its recording", ^BOOL {
            SPCaptureRecording *current = nil;
            @synchronized ([SPCaptureRecording class]) { current = captureRecording; }
            if (current == nil) return NO;
            @synchronized (current) { return current.closed; }
        });
        dispatch_semaphore_signal(held);
        sp_run_until("the ended start returns", ^BOOL { return startReturned; });
        dispatch_release(held);
        NSString *want = @"the first still was not written before the endpoint connection of the request closed";
        check(!started && startError != NULL && strcmp(startError, want.UTF8String) == 0,
            [NSString stringWithFormat:@"an end of its token ends the wait of the start for still 0 (%s)", startError ?: ""]);
        check(!recordingActive(), @"the start whose wait ended leaves no recording");
        free(startError);
    }
    free(operationError); operationError = NULL;
    [pending close];
    [pending release];

    // A scheduled stop leaves the main thread free: while it waits for a still that the plan has not reached, the main thread
    // closes another window, whose close ends the wait of the stop, and the stop answers its context once.
    hostInstallMainThread(directly, directly);
    sp_host_diagnostic_callbacks diagnostics = {0};
#define INITIALIZE_DIAGNOSTIC(mode, result, name, parameters, arguments) diagnostics.name = stub_##name;
    SP_HOST_DIAGNOSTIC_CALLBACKS(INITIALIZE_DIAGNOSTIC)
#undef INITIALIZE_DIAGNOSTIC
    diagnostics.capture_answered = captureAnswered;
    check(sp_host_diagnostic_callbacks_install(&diagnostics) == NULL, @"the capture answer callback is registered");
    NSWindow *scheduled = makeWindow();
    if (startRecording(scheduled, folder(root, @"scheduled"), 10, 4096, 22)) {
        NSWindow *other = makeWindow();
        __block bool closedOnMain = false;
        id closeObserver = [[NSNotificationCenter defaultCenter] addObserverForName:NSWindowWillCloseNotification
            object:other queue:nil usingBlock:^(NSNotification *note) {
            (void)note;
            closedOnMain = NSThread.isMainThread && captureAnswers == 0;
            endCaptureWait(23, "the window closed");
        }];
        SPCaptureRecording *current = nil;
        @synchronized ([SPCaptureRecording class]) { current = [captureRecording retain]; }
        scheduleCaptureStop(sp_capture_clock() + 3600000, 23, 41);
        sp_run_until("the scheduled stop waits for its still", ^BOOL {
            @synchronized (current) { return current.stopArmed; }
        });
        [current release];
        [other close];
        sp_run_until("the scheduled stop answers", ^BOOL { return captureAnswers > 0; });
        drainMainQueue();
        NSString *want = @"no still was requested at the requested time before the window closed";
        check(closedOnMain, @"the main thread closes a window while a scheduled stop waits");
        check(captureAnswers == 1 && captureAnswerContext == 41 && captureAnswerResult > 0 && captureAnswerFailure != NULL
            && strstr(captureAnswerFailure, want.UTF8String) != NULL,
            [NSString stringWithFormat:@"the close of the window ends the scheduled stop, which answers its context once "
                "(%d answers, context %lu, %ld frames, %s)", captureAnswers, (unsigned long)captureAnswerContext,
                captureAnswerResult, captureAnswerFailure ?: "no failure"]);
        free(captureAnswerFailure); captureAnswerFailure = NULL;
        [[NSNotificationCenter defaultCenter] removeObserver:closeObserver];
        [other release];
    }
    [scheduled close];
    [scheduled release];
    fprintf(stderr, "END: the ends of the capture waits\n");

    // A request during a recording keeps the recording, its error and its prepared window.
    if (startRecording(window, folder(root, @"failing"), 10, 4096, 30)) {
        setCaptureError(@"fixture recording failure before open");
        check(!sp_capture_open(-1, false, &operationError), @"open rejects an active recording");
        check(strstr(sp_capture_error(), "fixture recording failure before open") != NULL,
            @"rejected open preserves the active recording error");
        check(captureWindowNumber == window.windowNumber, @"rejected open preserves the prepared window");
        check(operationError != NULL && strstr(operationError, "already running") != NULL,
            @"the rejected open returns its own active-recording reason");
        free(operationError); operationError = NULL;
        check(!sp_capture_start(root.fileSystemRepresentation, 10, 0, 4, 31, &operationError),
            @"start rejects an active recording");
        check(strstr(sp_capture_error(), "fixture recording failure before open") != NULL,
            @"rejected start preserves the active recording error");
        check(operationError != NULL && strstr(operationError, "already running") != NULL,
            @"the rejected start returns its own active-recording reason");
        free(operationError); operationError = NULL;
        sp_capture_stop(0, 32);
    }
    if (startRecording(window, folder(root, @"healthy"), 10, 4096, 33)) {
        check(!sp_capture_open(-1, false, &operationError), @"open also rejects a healthy active recording");
        free(operationError); operationError = NULL;
        check(!sp_capture_start(root.fileSystemRepresentation, 10, 0, 4, 34, &operationError),
            @"start also rejects a healthy active recording");
        free(operationError); operationError = NULL;
        // A still request fails with its own error and leaves the recording as it is.
        char *stillError = NULL;
        check(!sp_capture_still(-1, NULL, &stillError) && stillError != NULL && strstr(stillError, "needs a path") != NULL,
            @"a null still path is rejected during recording with its own error");
        free(stillError); stillError = NULL;
        NSString *stillPath = [root stringByAppendingPathComponent:@"invalid-window.png"];
        check(!sp_capture_still(-1, stillPath.fileSystemRepresentation, &stillError) && stillError != NULL
            && strstr(stillError, "window -1 is not on screen") != NULL,
            [NSString stringWithFormat:@"an invalid-window still returns its own window failure (%s)", stillError ?: ""]);
        free(stillError); stillError = NULL;
        BOOL invalidRejected = NO;
        @try { invalidRejected = !sp_capture_still(-1, "\xff", &stillError); }
        @catch (NSException *exception) {
            fprintf(stderr, "UTF8 fixture exception: %s\n", exception.reason.UTF8String);
        }
        check(invalidRejected && stillError != NULL && strstr(stillError, "UTF-8") != NULL,
            @"invalid UTF-8 still paths return their own explicit failure without exceptions");
        free(stillError); stillError = NULL;
        int written = sp_capture_stop(0, 35);
        check(written > 0 && strlen(sp_capture_error()) == 0,
            [NSString stringWithFormat:@"rejected requests and failed stills leave a healthy recording healthy (%d, %@)", written,
                errorText()]);
    }
    setCaptureError(@"fixture later recording failure");
    char *stillError = NULL;
    check(!sp_capture_still(-1, [root stringByAppendingPathComponent:@"after.png"].fileSystemRepresentation, &stillError),
        @"a still of a missing window fails after a recording");
    free(stillError);
    check([errorText() isEqual:@"fixture later recording failure"], @"a failed still cannot replace a recording error");

    // The folder of a recording is removed after its start: its later stills are not written, and the stop keeps that earlier
    // write error with the end of its own wait.
    NSString *removed = folder(root, @"removed");
    if (startRecording(window, removed, 10, 4096, 40)) {
        [NSFileManager.defaultManager removeItemAtPath:removed error:NULL];
        sp_run_until("a still fails to be written", ^BOOL { return hasCaptureError(); });
        check([errorText() containsString:@"not written"],
            [NSString stringWithFormat:@"the controlled file-write failure is observable before stop (%@)", errorText()]);
        sp_capture_end_wait(41, "the fixture ended the stop");
        sp_capture_stop(sp_capture_clock() + 3600000, 41);
        check(!recordingActive(), @"a stop error retires the current recording");
        check([errorText() containsString:@"not written"],
            [NSString stringWithFormat:@"stop preserves the earlier recording write error (%@)", errorText()]);
        check([errorText() containsString:@"no still was requested at the requested time before the fixture ended the stop"],
            [NSString stringWithFormat:@"stop reports the separate end of its wait (%@)", errorText()]);
    }
    captureLookup = dlsym;
    [window close];
    [window release];
    fprintf(stderr, "%s: capture pressure and still-result isolation (%.1fms)\n",
        failures ? "FAIL" : "PASS", (CACurrentMediaTime() - began) * 1000);
    return failures ? 1 : 0;
}}
