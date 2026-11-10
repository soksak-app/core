// Injects queue capacity and file write faults into the real sample handler. Capture internal state is accessed only by the ownership check.
#import "../src/capture.m"
#import "../src/host_api_capture.m"
#import "support/temporary_folder.h"
#import <objc/runtime.h>
#import "support/run_until.h"

static int failures;
static void check(BOOL ok, NSString *label) {
    fprintf(ok ? stdout : stderr, "%s: %s\n", ok ? "PASS" : "FAIL", label.UTF8String);
    if (!ok) failures++;
}

// Holds the query callback of a still capture. The test delivers it after the call began to wait, to check that the call waits
// for it, and after the end of the still wait, to check the lifetime of the per-call state.
static void (^heldStillReply)(SCShareableContent *, NSError *);
static dispatch_semaphore_t stillQueryHeld;
static void holdStillQuery(id receiver, SEL selector, void (^reply)(SCShareableContent *, NSError *)) {
    heldStillReply = [reply copy];
    if (stillQueryHeld) dispatch_semaphore_signal(stillQueryHeld);
}

// The worker and the main-thread function of a host: on another thread both run the block directly (main_thread.h).
static void directly(void (^work)(void)) { work(); }
#define STUB_V(result, name, parameters) static result stub_##name parameters {}
#define STUB(mode, result, name, parameters, arguments) STUB_##mode(result, name, parameters)
SP_HOST_DIAGNOSTIC_CALLBACKS(STUB)

// The answer of a scheduled capture call, which reaches the main thread as an event.
static bool captureAnswerArrived;
static uintptr_t captureAnswerContext;
static long captureAnswerResult;
static char *captureAnswerFailure;
static void captureAnswered(uintptr_t context, long result, char *failure) {
    char *copied = failure ? strdup(failure) : NULL;
    dispatch_async(dispatch_get_main_queue(), ^{
        captureAnswerContext = context;
        captureAnswerResult = result;
        captureAnswerFailure = copied;
        captureAnswerArrived = true;
    });
}

@interface CaptureStopFixture : NSObject
@end
@implementation CaptureStopFixture
- (void)stopCaptureWithCompletionHandler:(void (^)(NSError *))completion {
    completion([NSError errorWithDomain:@"capture.test" code:1
        userInfo:@{NSLocalizedDescriptionKey: @"fixture stop failure"}]);
}
@end

static CMSampleBufferRef sample(void) {
    CVPixelBufferRef pixels = NULL;
    check(CVPixelBufferCreate(NULL, 4, 4, kCVPixelFormatType_32BGRA, NULL, &pixels) == kCVReturnSuccess,
        @"the controlled sample has a pixel buffer");
    CMVideoFormatDescriptionRef format = NULL;
    check(CMVideoFormatDescriptionCreateForImageBuffer(NULL, pixels, &format) == noErr,
        @"the controlled sample has an image format");
    CMSampleTimingInfo timing = { kCMTimeInvalid, kCMTimeZero, kCMTimeInvalid };
    CMSampleBufferRef result = NULL;
    check(CMSampleBufferCreateReadyWithImageBuffer(NULL, pixels, format, &timing, &result) == noErr,
        @"the controlled sample is ready");
    CFMutableDictionaryRef attachments = (CFMutableDictionaryRef)CFArrayGetValueAtIndex(
        CMSampleBufferGetSampleAttachmentsArray(result, true), 0);
    NSDictionary *metadata = @{
        SCStreamFrameInfoStatus: @(SCFrameStatusComplete),
        SCStreamFrameInfoDisplayTime: @(mach_absolute_time()),
        SCStreamFrameInfoScaleFactor: @1, SCStreamFrameInfoContentScale: @1,
        SCStreamFrameInfoContentRect: (NSDictionary *)[(__bridge NSDictionary *)
            CGRectCreateDictionaryRepresentation(CGRectMake(0, 0, 4, 4)) autorelease],
    };
    for (NSString *key in metadata) CFDictionarySetValue(attachments, key, metadata[key]);
    CFRelease(format); CVPixelBufferRelease(pixels);
    return result;
}

static void reset(NSString *directory, long capacity) {
    clearCaptureError();
    captureBefore = 0; captureStartedAt = 0; captureLimitReached = false;
    [captureSink release]; captureSink = [SPCapture new];
    captureSink.directory = directory;
    static int counts[6]; memset(counts, 0, sizeof counts); captureSink.statuses = counts;
    if (capturePending) dispatch_release(capturePending);
    capturePending = dispatch_semaphore_create(capacity);
    if (captureFirstFrame) dispatch_release(captureFirstFrame);
    captureFirstFrame = dispatch_semaphore_create(0);
    // A recording of the fixture is in the state in which the start request has completed.
    if (captureStartDone) dispatch_release(captureStartDone);
    captureStartDone = dispatch_semaphore_create(1);
}

int main(void) { @autoreleasepool {
    CFTimeInterval began = CACurrentMediaTime();
    fprintf(stderr, "START: capture pressure and still-result isolation\n");
    [NSApplication sharedApplication];
    NSString *directory = temporaryFolder(@"soksak-capture-pressure-");
    captureWriter = dispatch_queue_create("capture.test.writer", DISPATCH_QUEUE_SERIAL);
    CMSampleBufferRef frame = sample();
    reset(directory, 0);
    // The sample callback runs on this thread: a callback that waited for writer capacity would hold it here, and the check
    // after it is reached by the return of the callback.
    bool returned = false;
    [captureSink write:frame];
    returned = true;
    check(returned, @"exhausted writer capacity never blocks the sample callback");
    dispatch_sync(captureWriter, ^{});
    check(strstr(sp_capture_error(), "pending") != NULL,
        @"exhausted writer capacity reports an explicit recording error");
    check(captureSink.queued == 0 && captureSink.written == 0,
        @"an exhausted recording does not accept a delayed frame");

    reset(directory, 1);
    [captureSink write:frame]; dispatch_sync(captureWriter, ^{});
    check(strlen(sp_capture_error()) == 0 && captureSink.queued == 1 && captureSink.written == 1,
        @"available writer capacity preserves a complete frame");

    reset(directory, 1);
    captureSink.queued = 600; captureSink.written = 600;
    [captureSink write:frame]; dispatch_sync(captureWriter, ^{});
    check(captureSink.queued == 601 && captureSink.written == 601,
        @"a healthy recording writes the frame after 600 accepted frames");
    check(!sp_capture_limited() && strlen(sp_capture_error()) == 0,
        @"600 accepted frames do not limit a healthy recording");
    check([[NSFileManager defaultManager] fileExistsAtPath:
        [directory stringByAppendingPathComponent:@"frame-0601.bgra"]],
        @"the frame after the former cutoff is committed to disk");
    for (int index = (int)captureSink.callbackStatusTrace.count;
        index < kCaptureMaxCallbackStatusRecords; index++) {
        [captureSink.callbackStatusTrace addObject:@{}];
    }
    [captureSink write:frame]; dispatch_sync(captureWriter, ^{});
    check(sp_capture_limited() && strstr(sp_capture_error(), "callback status trace capacity") != NULL,
        @"callback evidence capacity reports a limit and an explicit error");
    check(captureSink.queued == 601 && captureSink.written == 601,
        @"callback capacity exhaustion cannot accept an unrecorded frame");
    reset(directory, 1);
    [captureSink write:frame]; dispatch_sync(captureWriter, ^{});

    captureStream = (SCStream *)[NSObject new];
    check(sp_capture_wait(0) == 1,
        @"a written first frame without recording errors is ready");
    [captureStream release]; captureStream = nil;

    reset(directory, 1);
    [captureSink write:frame]; dispatch_sync(captureWriter, ^{});
    captureStream = (SCStream *)[NSObject new];
    [captureSink stream:captureStream didStopWithError:
        [NSError errorWithDomain:@"capture.test" code:2
            userInfo:@{NSLocalizedDescriptionKey: @"fixture ready stream failure"}]];
    check(captureSink.written == 1,
        @"the stream-error readiness fixture retains a complete first frame");
    check(sp_capture_wait(0) == 0,
        @"a known stream failure rejects a written first frame readiness");
    check(strstr(sp_capture_error(), "fixture ready stream failure") != NULL,
        @"first-frame readiness preserves the original stream failure");
    [captureStream release]; captureStream = nil;

    reset(directory, 1);
    [captureSink write:frame]; dispatch_sync(captureWriter, ^{});
    captureStream = (SCStream *)[NSObject new];
    // Injects, after the first frame, the same error boundary that the asynchronous start completion records.
    setCaptureError(@"capture did not start: fixture asynchronous start failure");
    check(sp_capture_wait(0) == 0,
        @"a known asynchronous start failure rejects written first frame readiness");
    check(strstr(sp_capture_error(), "fixture asynchronous start failure") != NULL,
        @"first-frame readiness preserves the asynchronous start failure");
    [captureStream release]; captureStream = nil;

    fprintf(stderr, "START: the ends of the capture waits\n");
    // A first frame that does not come: the end from another thread ends the wait, whether it comes before or while the wait
    // holds this thread.
    reset(directory, 1);
    captureStream = (SCStream *)[NSObject new];
    dispatch_async(dispatch_get_global_queue(QOS_CLASS_USER_INITIATED, 0), ^{
        sp_capture_end_wait(10, "the endpoint connection of the request closed");
    });
    check(sp_capture_wait(10) == 0 && strcmp(sp_capture_error(),
        "no capture frame arrived before the endpoint connection of the request closed") == 0,
        [NSString stringWithFormat:@"an end from another thread ends the first-frame wait (%s)", sp_capture_error()]);
    // The end of a returned call changes no later call: the later call waits for its own frame.
    sp_capture_end_wait(10, "the window closed");
    reset(directory, 1);
    dispatch_async(dispatch_get_global_queue(QOS_CLASS_USER_INITIATED, 0), ^{
        [captureSink write:frame]; dispatch_sync(captureWriter, ^{});
    });
    check(sp_capture_wait(11) == 1 && strlen(sp_capture_error()) == 0,
        [NSString stringWithFormat:@"the end of a returned call does not end a later wait (%s)", sp_capture_error()]);
    // A frame that came before the end is taken: the wait whose event came is not ended.
    reset(directory, 1);
    [captureSink write:frame]; dispatch_sync(captureWriter, ^{});
    sp_capture_end_wait(12, "the page of the window ended");
    check(sp_capture_wait(12) == 1 && strlen(sp_capture_error()) == 0,
        [NSString stringWithFormat:@"a frame that came before the end answers its wait (%s)", sp_capture_error()]);
    // The end of another token leaves the wait to its own event.
    reset(directory, 1);
    sp_capture_end_wait(14, "the window closed");
    dispatch_async(dispatch_get_global_queue(QOS_CLASS_USER_INITIATED, 0), ^{
        [captureSink write:frame]; dispatch_sync(captureWriter, ^{});
    });
    check(sp_capture_wait(13) == 1 && strlen(sp_capture_error()) == 0,
        [NSString stringWithFormat:@"the end of another call does not end this wait (%s)", sp_capture_error()]);
    [captureStream release]; captureStream = nil;

    // A scheduled capture wait leaves the main thread free: while it waits for a first frame that does not come, the main
    // thread closes a window, and the close of that window ends the wait, which answers with one capture_answered event.
    hostInstallMainThread(directly, directly);
    sp_host_diagnostic_callbacks diagnostics = {0};
#define INITIALIZE_DIAGNOSTIC(mode, result, name, parameters, arguments) diagnostics.name = stub_##name;
    SP_HOST_DIAGNOSTIC_CALLBACKS(INITIALIZE_DIAGNOSTIC)
#undef INITIALIZE_DIAGNOSTIC
    diagnostics.capture_answered = captureAnswered;
    check(sp_host_diagnostic_callbacks_install(&diagnostics) == NULL, @"the capture answer callback is registered");
    reset(directory, 1);
    captureStream = (SCStream *)[NSObject new];
    NSWindow *closing = [[NSWindow alloc] initWithContentRect:NSMakeRect(0, 0, 40, 40)
        styleMask:NSWindowStyleMaskBorderless backing:NSBackingStoreBuffered defer:YES];
    closing.releasedWhenClosed = NO;
    __block bool closedOnMain = false;
    id closeObserver = [[NSNotificationCenter defaultCenter] addObserverForName:NSWindowWillCloseNotification
        object:closing queue:nil usingBlock:^(NSNotification *note) {
        closedOnMain = NSThread.isMainThread && !captureAnswerArrived;
        endCaptureWait(20, "the window closed");
    }];
    scheduleCaptureWait(20, 41);
    dispatch_async(dispatch_get_main_queue(), ^{ [closing close]; });
    sp_run_until("the capture wait answers", ^BOOL { return captureAnswerArrived; });
    check(closedOnMain, @"the main thread closes a window while a scheduled capture wait waits");
    check(captureAnswerContext == 41 && captureAnswerResult == 0 && captureAnswerFailure != NULL
        && strcmp(captureAnswerFailure, "no capture frame arrived before the window closed") == 0,
        [NSString stringWithFormat:@"the close of the window ends the capture wait, which answers its context once (%s)",
            captureAnswerFailure ?: "no failure"]);
    free(captureAnswerFailure); captureAnswerFailure = NULL;
    [[NSNotificationCenter defaultCenter] removeObserver:closeObserver];
    [closing release];
    [captureStream release]; captureStream = nil;
    fprintf(stderr, "END: the ends of the capture waits\n");

    char *operationError = NULL;
    SCContentFilter *prepared = (SCContentFilter *)[NSObject new];
    SCStreamConfiguration *configuration = (SCStreamConfiguration *)[NSObject new];
    reset(directory, 1);
    [captureSink write:frame]; dispatch_sync(captureWriter, ^{});
    captureFilter = prepared; captureConfig = configuration;
    captureStream = (SCStream *)[NSObject new];
    setCaptureError(@"fixture recording failure before open");
    check(!sp_capture_open(-1, false, 0, &operationError), @"open rejects an active recording");
    check(strstr(sp_capture_error(), "fixture recording failure before open") != NULL,
        @"rejected open preserves the active recording error");
    check(captureFilter == prepared && captureConfig == configuration,
        @"rejected open preserves the prepared recording target");
    check(operationError != NULL && strstr(operationError, "already running") != NULL,
        @"the rejected operation returns its own active-recording reason");
    free(operationError); operationError = NULL;
    [captureStream release]; captureStream = nil;

    reset(directory, 1);
    [captureSink write:frame]; dispatch_sync(captureWriter, ^{});
    captureFilter = prepared; captureConfig = configuration;
    captureStream = (SCStream *)[NSObject new];
    check(!sp_capture_open(-1, false, 0, &operationError), @"open also rejects a healthy active recording");
    check(sp_capture_wait(0) == 1, @"rejected open preserves healthy recording readiness");
    check(operationError != NULL && strstr(operationError, "already running") != NULL,
        @"the rejected operation returns its own active-recording reason");
    free(operationError); operationError = NULL;
    [captureStream release]; captureStream = nil;

    reset(directory, 1);
    [captureSink write:frame]; dispatch_sync(captureWriter, ^{});
    captureFilter = prepared; captureConfig = configuration;
    captureStream = (SCStream *)[NSObject new];
    setCaptureError(@"fixture recording failure before start");
    check(!sp_capture_start(directory.UTF8String, false, &operationError), @"start rejects an active recording");
    check(strstr(sp_capture_error(), "fixture recording failure before start") != NULL,
        @"rejected start preserves the active recording error");
    check(operationError != NULL && strstr(operationError, "already running") != NULL,
        @"the rejected operation returns its own active-recording reason");
    free(operationError); operationError = NULL;
    [captureStream release]; captureStream = nil;

    reset(directory, 1);
    [captureSink write:frame]; dispatch_sync(captureWriter, ^{});
    captureFilter = prepared; captureConfig = configuration;
    captureStream = (SCStream *)[NSObject new];
    check(!sp_capture_start(directory.UTF8String, false, &operationError), @"start also rejects a healthy active recording");
    check(sp_capture_wait(0) == 1, @"rejected start preserves healthy recording readiness");
    check(operationError != NULL && strstr(operationError, "already running") != NULL,
        @"the rejected operation returns its own active-recording reason");
    free(operationError); operationError = NULL;
    [captureStream release]; captureStream = nil;
    captureFilter = nil; captureConfig = nil;
    [prepared release]; [configuration release];

    reset(directory, 1);
    [captureSink write:frame]; dispatch_sync(captureWriter, ^{});
    captureStream = (SCStream *)[NSObject new];
    setCaptureError(@"fixture active recording failure");
    char *stillError = NULL;
    check(!sp_capture_still((long[]){-1}, 1, NULL, 0, &stillError), @"a null still path is rejected during recording");
    check(strstr(sp_capture_error(), "fixture active recording failure") != NULL,
        @"a failed still request preserves the existing recording error");
    check(stillError != NULL && strstr(stillError, "needs a path") != NULL,
        @"the still call returns its own path failure");
    free(stillError); stillError = NULL;
    [captureStream release]; captureStream = nil;

    reset(directory, 1);
    [captureSink write:frame]; dispatch_sync(captureWriter, ^{});
    captureStream = (SCStream *)[NSObject new];
    NSString *stillPath = [directory stringByAppendingPathComponent:@"invalid-window.png"];
    check(!sp_capture_still((long[]){-1}, 1, stillPath.UTF8String, 0, &stillError),
        @"an asynchronous invalid-window still capture is rejected");
    check(sp_capture_wait(0) == 1,
        @"an unrelated asynchronous still failure preserves healthy recording readiness");
    [captureStream release]; captureStream = nil;
    check(stillError != NULL && strstr(stillError, "not found") != NULL,
        @"the asynchronous still call returns its own window failure");
    free(stillError); stillError = NULL;
    BOOL invalidRejected = NO;
    @try { invalidRejected = !sp_capture_still((long[]){-1}, 1, "\xff", 0, &stillError); }
    @catch (NSException *exception) {
        fprintf(stderr, "UTF8 fixture exception: %s\n", exception.reason.UTF8String);
    }
    check(invalidRejected, @"invalid UTF-8 still paths return an explicit failure without exceptions");
    check(stillError != NULL && strstr(stillError, "UTF-8") != NULL,
        @"invalid UTF-8 has its own explicit still error");
    free(stillError);

    fprintf(stderr, "START: still end and late callback\n");
    Method query = class_getClassMethod([SCShareableContent class],
        @selector(getCurrentProcessShareableContentWithCompletionHandler:));
    check(query != NULL, @"the still-query fault boundary is available");
    if (query != NULL) {
        IMP original = method_setImplementation(query, (IMP)holdStillQuery);
        stillError = NULL;
        // The end comes before the call waits, so the held query is ended without a race.
        sp_capture_end_wait(20, "the fixture ended the still");
        BOOL ended = !sp_capture_still((long[]){-1}, 1, stillPath.UTF8String, 20, &stillError);
        method_setImplementation(query, original);
        check(ended && stillError != NULL
            && strcmp(stillError, "still capture did not answer before the fixture ended the still") == 0,
            [NSString stringWithFormat:@"a held still query returns its own end error (%s)", stillError]);
        check(heldStillReply != nil, @"the delayed still callback is retained");
        clearCaptureError(); setCaptureError(@"fixture later recording failure");
        if (heldStillReply != nil) {
            heldStillReply(nil, [NSError errorWithDomain:@"capture.test" code:3
                userInfo:@{NSLocalizedDescriptionKey: @"fixture late still failure"}]);
            [heldStillReply release]; heldStillReply = nil;
        }
        check(strstr(sp_capture_error(), "fixture later recording failure") != NULL,
            @"a late still callback cannot replace a later recording error");
        check(stillError != NULL && strstr(stillError, "before the fixture ended the still") != NULL,
            @"a returned still end error remains owned by its caller");
        free(stillError);

        // A still query whose callback arrives while the call waits: the call waits for it and returns its result.
        original = method_setImplementation(query, (IMP)holdStillQuery);
        stillQueryHeld = dispatch_semaphore_create(0);
        dispatch_async(dispatch_get_global_queue(QOS_CLASS_DEFAULT, 0), ^{
            dispatch_semaphore_wait(stillQueryHeld, DISPATCH_TIME_FOREVER);
            void (^reply)(SCShareableContent *, NSError *) = heldStillReply;
            heldStillReply = nil;
            if (reply == nil) return;
            reply(nil, [NSError errorWithDomain:@"capture.test" code:3
                userInfo:@{NSLocalizedDescriptionKey: @"fixture late still failure"}]);
            [reply release];
        });
        stillError = NULL;
        BOOL rejected = !sp_capture_still((long[]){-1}, 1, stillPath.UTF8String, 22, &stillError);
        method_setImplementation(query, original);
        dispatch_release(stillQueryHeld); stillQueryHeld = NULL;
        check(rejected && stillError != NULL && strstr(stillError, "fixture late still failure") != NULL,
            @"a held still query returns the result of its late callback");
        check(strstr(sp_capture_error(), "fixture later recording failure") != NULL
            && strstr(sp_capture_error(), "fixture late still failure") == NULL,
            @"a late still callback cannot replace a recording error");
        free(stillError);
    }
    fprintf(stderr, "END: still end and late callback\n");

    reset([directory stringByAppendingPathComponent:@"missing"], 1);
    [captureSink write:frame]; dispatch_sync(captureWriter, ^{});
    check(strstr(sp_capture_error(), "not written") != NULL,
        @"the controlled file-write failure is observable before stop");
    captureStream = (SCStream *)[CaptureStopFixture new];
    captureQueue = dispatch_queue_create("capture.test.samples", DISPATCH_QUEUE_SERIAL);
    check(sp_capture_has_stream(), @"the capture module reports its current native stream");
    sp_capture_stop(0, 0);
    check(strstr(sp_capture_error(), "no attempt context") != NULL,
        @"a stop without attempt context reports its preflight error");
    check(sp_capture_has_stream(), @"a rejected preflight keeps the current native stream owned");
    SPCaptureAttempt *stopAttempt = [SPCaptureAttempt new];
    stopAttempt.session = @"capture-pressure-stop";
    stopAttempt.startCompletionSeen = YES;
    [captureAttempt release]; captureAttempt = [stopAttempt retain];
    objc_setAssociatedObject(captureStream, &captureAttemptAssociationKey, stopAttempt, OBJC_ASSOCIATION_RETAIN);
    [stopAttempt release];
    // No frame comes to the fixture stream; the end, given before the stop waits, ends its wait for the boundary.
    sp_capture_end_wait(21, "the fixture ended the stop");
    sp_capture_stop(0, 21);
    check(!sp_capture_has_stream(), @"a stop error retires the current native stream");
    NSString *stopError = [NSString stringWithUTF8String:sp_capture_error()] ?: @"";
    check([stopError containsString:@"not written"],
        [NSString stringWithFormat:@"stop preserves the earlier recording write error (%@)", stopError]);
    check([stopError containsString:@"no frame arrived at the requested display time before the fixture ended the stop"],
        [NSString stringWithFormat:@"stop reports the separate end of its delivery wait (%@)", stopError]);
    check([stopError containsString:@"fixture stop failure"],
        [NSString stringWithFormat:@"stop reports the stream completion error alongside earlier failures (%@)", stopError]);

    // ScreenCaptureKit ends a stream with an error. The stream ends before any callback meets the stop boundary, so no
    // later callback follows and the stop ends by that end. The stop above wrote the source manifest of its recording, which
    // created the folder missing, so this write fails in a folder that no stop created.
    reset([directory stringByAppendingPathComponent:@"missing-at-stream-end"], 1);
    [captureSink write:frame]; dispatch_sync(captureWriter, ^{});
    check(strstr(sp_capture_error(), "not written") != NULL,
        @"the controlled file-write failure before the stream end is observable before stop");
    captureStream = (SCStream *)[CaptureStopFixture new];
    captureQueue = dispatch_queue_create("capture.test.samples", DISPATCH_QUEUE_SERIAL);
    SPCaptureAttempt *endedAttempt = [SPCaptureAttempt new];
    endedAttempt.session = @"capture-pressure-stream-end";
    endedAttempt.startCompletionSeen = YES;
    [captureAttempt release]; captureAttempt = [endedAttempt retain];
    objc_setAssociatedObject(captureStream, &captureAttemptAssociationKey, endedAttempt, OBJC_ASSOCIATION_RETAIN);
    [endedAttempt release];
    [captureSink stream:captureStream didStopWithError:
        [NSError errorWithDomain:@"capture.test" code:4
            userInfo:@{NSLocalizedDescriptionKey: @"fixture stream end failure"}]];
    sp_capture_stop(0, 23);
    check(!sp_capture_has_stream(), @"the stop of an ended stream retires the current native stream");
    stopError = [NSString stringWithUTF8String:sp_capture_error()] ?: @"";
    check([stopError containsString:@"not written"],
        [NSString stringWithFormat:@"the stop of an ended stream preserves the earlier recording write error (%@)", stopError]);
    check([stopError containsString:@"the stream ended before a frame arrived"],
        [NSString stringWithFormat:@"stop reports a stream that ended before its boundary (%@)", stopError]);
    check([stopError containsString:@"fixture stream end failure"],
        [NSString stringWithFormat:@"stop preserves the error that ended the stream (%@)", stopError]);
    check([stopError containsString:@"fixture stop failure"],
        [NSString stringWithFormat:@"the stop of an ended stream reports the stream completion error (%@)", stopError]);
    CFRelease(frame);
    fprintf(stderr, "%s: capture pressure and still-result isolation (%.1fms)\n",
        failures ? "FAIL" : "PASS", (CACurrentMediaTime() - began) * 1000);
    return failures ? 1 : 0;
}}
