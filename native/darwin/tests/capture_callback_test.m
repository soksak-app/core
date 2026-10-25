// Holds the start completion of a stream that was actually created and delivers it after replacement, to
// check error ownership.
#import "../src/capture.m"
#import "support/records.h"
#import "event_ring.h"
#import <objc/runtime.h>
#include <signal.h>
#include <unistd.h>

static int failures;
static NSMutableArray *starts;
static const int8_t captureTracePolicy[SP_CLASS_COUNT] = {SP_EVENT_DEBUG, SP_EVENT_ERROR, SP_EVENT_ERROR, SP_EVENT_ERROR, SP_EVENT_ERROR};
static void check(BOOL condition, NSString *message) {
    fprintf(stderr, "%s: %s\n", condition ? "PASS" : "FAIL", message.UTF8String);
    if (!condition) failures++;
}
static void expired(int signalNumber) {
    const char message[] = "FAIL: capture callback test exceeded 25000ms\n";
    write(STDERR_FILENO, message, sizeof message - 1); _exit(1);
}
static void holdStart(id stream, SEL selector, void (^reply)(NSError *)) {
    [starts addObject:[[reply copy] autorelease]];
}
static NSDictionary *lifecycleEvent(NSArray<NSDictionary *> *events, NSString *phase, NSString *session) {
    for (NSDictionary *event in events) {
        NSDictionary *fields = event[@"fields"];
        if ([event[@"name"] isEqual:@"native.capture.lifecycle"] && [fields[@"phase"] isEqual:phase]
            && (session == nil || [fields[@"session"] isEqual:session])) return event;
    }
    return nil;
}
static BOOL lifecycleMachTickFieldsMatchSchema(NSArray<NSDictionary *> *events) {
    NSArray<NSString *> *fields = @[@"requestMachTicks", @"callbackMachTicks", @"elapsedMachTicks",
        @"displayTimeMachTicks", @"factsObservedMachTicks", @"stopTargetMachTicks",
        @"stopRegistrationMachTicks", @"latestSampleCallbackMachTicks", @"latestSampleDisplayTimeMachTicks"];
    for (NSDictionary *event in events) {
        if (![event[@"name"] isEqual:@"native.capture.lifecycle"]) continue;
        NSDictionary *values = event[@"fields"];
        NSArray<NSString *> *required = @[@"stopAfterMilliseconds", @"stopTargetMachTicks",
            @"stopRegistrationMachTicks", @"latestSampleCallbackMachTicks", @"latestSampleStatusPresent",
            @"latestSampleStatus", @"latestSampleDisplayTimePresent", @"latestSampleDisplayTimeMachTicks"];
        for (NSString *field in required) if (values[field] == nil) return NO;
        if (![values[@"latestSampleStatusPresent"] isKindOfClass:NSNumber.class]
            || ![values[@"latestSampleDisplayTimePresent"] isKindOfClass:NSNumber.class]) return NO;
        for (NSString *field in fields) {
            id value = values[field];
            if (value != [NSNull null] && ![value isKindOfClass:NSString.class]) return NO;
        }
    }
    return YES;
}
static CMSampleBufferRef sampleWithStatus(BOOL includeStatus) {
    CMSampleTimingInfo timing = {kCMTimeInvalid, kCMTimeZero, kCMTimeInvalid};
    CMSampleBufferRef result = NULL;
    CMSampleBufferCreate(NULL, NULL, true, NULL, NULL, NULL, 1, 1, &timing, 0, NULL, &result);
    if (result == NULL) return NULL;
    CFArrayRef list = CMSampleBufferGetSampleAttachmentsArray(result, true);
    if (list == NULL || CFArrayGetCount(list) != 1) { CFRelease(result); return NULL; }
    if (includeStatus) {
        CFMutableDictionaryRef attachments = (CFMutableDictionaryRef)CFArrayGetValueAtIndex(list, 0);
        CFDictionarySetValue(attachments, SCStreamFrameInfoStatus, @((int)SCFrameStatusIdle));
    }
    return result;
}
static void inlineStart(id stream, SEL selector, void (^reply)(NSError *)) { reply(nil); }
static NSError *fault(NSString *message) {
    return [NSError errorWithDomain:@"capture.test" code:1 userInfo:@{NSLocalizedDescriptionKey:message}];
}
static BOOL start(NSString *directory) {
    char *error = NULL;
    BOOL started = sp_capture_start(directory.UTF8String, false, &error);
    check(started && error == NULL,
        [NSString stringWithFormat:@"the real stream registers its output before controlled completion (%s)", error]);
    free(error); return started;
}
static void discard(void) {
    // Release only the stream and queue of the ownership fault injection that did not actually start
    // a recording.
    [captureSink stopDisplayLinkObservation];
    [captureStream release]; captureStream = nil;
    if (captureQueue != NULL) { dispatch_release(captureQueue); captureQueue = NULL; }
}
int main(void) { @autoreleasepool {
    signal(SIGALRM, expired); alarm(25);
    check(sp_event_set_policy(captureTracePolicy), @"the test enables the bounded capture lifecycle trace");
    SPCaptureAttempt *maxTickAttempt = [[SPCaptureAttempt alloc] init];
    maxTickAttempt.session = @"capture-uint64-boundary";
    maxTickAttempt.timebase = (mach_timebase_info_data_t){ .numer = 1, .denom = 1 };
    NSArray *maxTickEvents = capturedEvents(^{
        [maxTickAttempt emit:@"uint64-boundary" level:SP_EVENT_DEBUG
            callbackMachTicks:[NSNumber numberWithUnsignedLongLong:UINT64_MAX]
            sampleType:nil statusPresent:NO status:nil displayTimePresent:YES
            displayTimeMachTicks:@"18446744073709551615" error:nil reason:nil];
    });
    NSDictionary *maxTick = lifecycleEvent(maxTickEvents, @"uint64-boundary", maxTickAttempt.session);
    check([maxTick[@"fields"][ @"callbackMachTicks"] isEqual:@"18446744073709551615"]
        && [maxTick[@"fields"][ @"elapsedMachTicks"] isEqual:@"18446744073709551615"]
        && [maxTick[@"fields"][ @"displayTimeMachTicks"] isEqual:@"18446744073709551615"],
        @"uint64 maximum Mach ticks remain canonical decimal strings without precision loss");
    [maxTickAttempt release];
    SPCaptureAttempt *stopFactsAttempt = [[SPCaptureAttempt alloc] init];
    stopFactsAttempt.session = @"capture-stop-facts";
    stopFactsAttempt.timebase = (mach_timebase_info_data_t){ .numer = 125, .denom = 3 };
    [stopFactsAttempt recordStopBoundaryAfterMilliseconds:123.5 targetMachTicks:987
        registrationMachTicks:765];
    [stopFactsAttempt recordLatestSampleStatusPresent:YES status:SCFrameStatusIdle displayTimePresent:YES
        displayTimeMachTicks:888 callbackMachTicks:999];
    NSArray *stopFactsEvents = capturedEvents(^{
        [stopFactsAttempt recordFailure:@"stop catch-up timeout" error:nil];
    });
    NSDictionary *stopFacts = lifecycleEvent(stopFactsEvents, @"failed", stopFactsAttempt.session);
    NSDictionary *stopFields = stopFacts[@"fields"];
    check([stopFields[@"stopAfterMilliseconds"] isEqual:@123.5]
        && [stopFields[@"stopTargetMachTicks"] isEqual:@"987"]
        && [stopFields[@"stopRegistrationMachTicks"] isEqual:@"765"]
        && [stopFields[@"latestSampleCallbackMachTicks"] isEqual:@"999"]
        && [stopFields[@"latestSampleStatusPresent"] boolValue]
        && [stopFields[@"latestSampleStatus"] intValue] == SCFrameStatusIdle
        && [stopFields[@"latestSampleDisplayTimePresent"] boolValue]
        && [stopFields[@"latestSampleDisplayTimeMachTicks"] isEqual:@"888"],
        @"stop failure summaries preserve the requested boundary and latest callback facts");
    [stopFactsAttempt release];
    CFTimeInterval began = CACurrentMediaTime();
    fprintf(stderr, "START: native delayed stream callback isolation\n");
    [NSApplication sharedApplication]; [NSApp setActivationPolicy:NSApplicationActivationPolicyAccessory];
    [NSApp finishLaunching];
    NSWindow *window = [[NSWindow alloc] initWithContentRect:NSMakeRect(120,120,200,100)
        styleMask:NSWindowStyleMaskBorderless backing:NSBackingStoreBuffered defer:NO];
    window.releasedWhenClosed = NO; window.animationBehavior = NSWindowAnimationBehaviorNone;
    [window orderFrontRegardless];
    SPCapture *linkFixture = [[SPCapture alloc] init];
    linkFixture.displayWindow = window;
    CADisplayLink *staleLink = [[window displayLinkWithTarget:linkFixture selector:@selector(displayLinkDidRefresh:)] retain];
    CADisplayLink *currentLink = [[window displayLinkWithTarget:linkFixture selector:@selector(displayLinkDidRefresh:)] retain];
    linkFixture.displayLink = currentLink;
    linkFixture.displayLinkStopped = NO;
    BOOL distinctLinks = staleLink != nil && currentLink != nil && staleLink != currentLink;
    check(distinctLinks, @"the stale display-link fixture has distinct prior and current links");
    if (distinctLinks) [linkFixture displayLinkDidRefresh:staleLink];
    NSDictionary *staleLinkRecord = [linkFixture displayLinkRecord];
    check([staleLinkRecord[@"state"] isEqual:@"unavailable"]
        && [staleLinkRecord[@"observations"] count] == 0,
        @"a delayed prior display-link callback cannot alter the current observation");
    [linkFixture stopDisplayLinkObservation];
    [staleLink invalidate]; [staleLink release];
    [currentLink release]; [linkFixture release];
    char path[] = "/tmp/soksak-capture-callback-XXXXXX";
    BOOL created = mkdtemp(path) != NULL;
    NSString *directory = created ? [NSString stringWithUTF8String:path] : @"";
    check(created, created ? @"the callback directory is created" :
        [NSString stringWithFormat:@"the callback directory creation failed: %s", strerror(errno)]);
    char *error = NULL;
    BOOL opened = sp_capture_open(window.windowNumber, false, &error);
    check(opened && error == NULL, [NSString stringWithFormat:@"the real inactive fixture prepares its target (%s)", error]);
    free(error);
    Method method = class_getInstanceMethod([SCStream class], @selector(startCaptureWithCompletionHandler:));
    check(method != NULL, @"the controlled start completion boundary exists");
    starts = [NSMutableArray new];
    if (created && opened && method != NULL) {
        IMP original = method_setImplementation(method, (IMP)holdStart);
        for (int failed = 0; failed < 2; failed++) {
            CFTimeInterval phase = CACurrentMediaTime();
            fprintf(stderr, "START: delayed callback with %s current recording\n", failed ? "failed" : "healthy");
            [starts removeAllObjects];
            __block BOOL oldStarted = NO;
            NSArray *oldStartEvents = capturedEvents(^{ oldStarted = start(directory); });
            NSDictionary *oldRequest = lifecycleEvent(oldStartEvents, @"start-request", nil);
            check(oldStarted && oldRequest != nil, @"the old stream request is recorded before its start callback");
            check([oldRequest[@"fields"][@"requestMachTicks"] isKindOfClass:NSString.class]
            && [oldRequest[@"fields"][@"machTimebaseNumerator"] unsignedIntValue] > 0
            && [oldRequest[@"fields"][@"machTimebaseDenominator"] unsignedIntValue] > 0,
            @"the start request carries raw Mach ticks with its captured timebase");
            NSString *oldSession = oldRequest[@"fields"][@"session"];
            SCStream *old = [captureStream retain];
            discard();
            __block BOOL currentStarted = NO;
            NSArray *currentStartEvents = capturedEvents(^{ currentStarted = start(directory); });
            NSDictionary *currentRequest = lifecycleEvent(currentStartEvents, @"start-request", nil);
            check(currentStarted && currentRequest != nil, @"the replacement stream request is recorded");
            NSString *currentSession = currentRequest[@"fields"][@"session"];
            SCStream *current = captureStream;
            check(current != old && starts.count == 2, @"the controlled records have distinct real stream identities");
            if (starts.count == 2) {
                NSArray *oldCallbackEvents = capturedEvents(^{
                    if (failed) setCaptureError(@"fixture current recording error");
                    void (^oldStart)(NSError *) = starts[0];
                    oldStart(fault(@"fixture late start failure"));
                    check(strcmp(sp_capture_error(), failed ? "fixture current recording error" : "") == 0,
                        @"late start preserves the exact current recording error");
                    if (!failed) {
                        // The fixture reports the current start completion
                        // instead of the current start that was held.
                        dispatch_semaphore_signal(captureStartDone);
                        dispatch_semaphore_signal(captureFirstFrame);
                        check(sp_capture_wait() == 1, @"late start cannot invalidate healthy first-frame readiness");
                    }
                    [captureSink stream:old didStopWithError:fault(@"fixture late delegate failure")];
                    check(strcmp(sp_capture_error(), failed ? "fixture current recording error" : "") == 0,
                        @"late delegate preserves the exact current recording error");
                    if (!failed) {
                        dispatch_semaphore_signal(captureFirstFrame);
                        check(sp_capture_wait() == 1, @"late delegate cannot invalidate healthy first-frame readiness");
                    }
                });
                NSDictionary *oldCompletion = lifecycleEvent(oldCallbackEvents, @"start-completion", oldSession);
                NSDictionary *oldStop = lifecycleEvent(oldCallbackEvents, @"delegate-stop", oldSession);
                NSDictionary *oldFailure = lifecycleEvent(oldCallbackEvents, @"failed", oldSession);
                check(lifecycleMachTickFieldsMatchSchema(oldCallbackEvents),
                    @"all old-stream lifecycle Mach-tick fields are strings or null");
                check(oldCompletion != nil && oldStop != nil,
                    @"late start and delegate callbacks retain the old stream's session identity");
                check([oldCompletion[@"fields"][@"errorDomain"] isEqual:@"capture.test"]
                    && [oldCompletion[@"fields"][@"errorCode"] intValue] == 1
                    && [oldCompletion[@"fields"][@"reason"] containsString:@"fixture late start failure"]
                    && [oldStop[@"fields"][@"errorDomain"] isEqual:@"capture.test"]
                    && [oldStop[@"fields"][@"errorCode"] intValue] == 1,
                    @"callback events preserve their source error domain, code and reason");
                check([oldFailure[@"fields"][@"errorDomain"] isEqual:@"capture.test"]
                    && [oldFailure[@"fields"][@"errorCode"] intValue] == 1
                    && [oldFailure[@"fields"][@"reason"] containsString:@"fixture late start failure"],
                    @"a late stream's first failure is summarized under its original session");
                BOOL lateStartReported = NO, lateDelegateReported = NO;
                for (NSDictionary *event in oldCallbackEvents) {
                    if (![event[@"name"] isEqual:@"native.record.error"]) continue;
                    NSString *text = event[@"fields"][@"text"];
                    lateStartReported |= [text containsString:@"fixture late start failure"];
                    lateDelegateReported |= [text containsString:@"fixture late delegate failure"];
                }
                check(lateStartReported && lateDelegateReported,
                    @"both late errors are reported instead of silently discarded");
                check(captureStream == current, @"late callbacks preserve the replacement stream");
                NSArray *currentCallbackEvents = capturedEvents(^{
                    void (^currentStart)(NSError *) = starts[1];
                    currentStart(fault(@"fixture active start failure"));
                    [captureSink stream:current didStopWithError:fault(@"fixture active delegate failure")];
                });
                check(lifecycleMachTickFieldsMatchSchema(currentCallbackEvents),
                    @"all current-stream lifecycle Mach-tick fields are strings or null");
                NSDictionary *currentCompletion = lifecycleEvent(currentCallbackEvents, @"start-completion", currentSession);
                NSDictionary *currentStop = lifecycleEvent(currentCallbackEvents, @"delegate-stop", currentSession);
                check(currentCompletion != nil && currentStop != nil,
                    @"current start and delegate callbacks retain the replacement session identity");
                NSArray *firstFailureEvents = failed ? oldCallbackEvents : currentCallbackEvents;
                NSDictionary *currentFailure = lifecycleEvent(firstFailureEvents, @"failed", currentSession);
                BOOL summaryMatches = failed
                    ? [currentFailure[@"fields"][@"reason"] containsString:@"fixture current recording error"]
                        && currentFailure[@"fields"][@"errorDomain"] == [NSNull null]
                    : [currentFailure[@"fields"][@"errorDomain"] isEqual:@"capture.test"]
                        && [currentFailure[@"fields"][@"errorCode"] intValue] == 1
                        && [currentFailure[@"fields"][@"reason"] containsString:@"fixture active start failure"];
                check(summaryMatches, @"the first-failure summary preserves its originating failure");
                check(strstr(sp_capture_error(),"fixture active start failure") != NULL,
                    @"the current start failure still changes its recording error");
                check(strstr(sp_capture_error(),"fixture active start failure") != NULL &&
                    strstr(sp_capture_error(),"fixture active delegate failure") != NULL &&
                    (!failed || strstr(sp_capture_error(),"fixture current recording error") != NULL),
                    @"current delegate failure retains every earlier current-recording error");
                dispatch_semaphore_signal(captureFirstFrame);
                check(sp_capture_wait() == 0, @"a current-stream error still rejects first-frame readiness");
            }
            discard(); [old release]; [starts removeAllObjects];
            fprintf(stderr,"END: delayed callback with %s current recording (%.1fms)\n",
                failed ? "failed" : "healthy", (CACurrentMediaTime()-phase)*1000);
        }
        method_setImplementation(method, original);
    }
    if (created && opened && method != NULL) {
        IMP originalMethod = method_getImplementation(method);
        method_setImplementation(method, (IMP)inlineStart);
        NSArray *inlineEvents = capturedEvents(^{ check(start(directory),
            @"the inline-completion attempt starts"); });
        check(lifecycleMachTickFieldsMatchSchema(inlineEvents),
            @"inline lifecycle Mach-tick fields are strings or null");
        NSDictionary *inlineRequest = lifecycleEvent(inlineEvents, @"start-request", nil);
        NSDictionary *inlineCompletion = lifecycleEvent(inlineEvents, @"start-completion", inlineRequest[@"fields"][@"session"]);
        NSUInteger requestIndex = inlineRequest == nil ? NSNotFound : [inlineEvents indexOfObject:inlineRequest];
        NSUInteger completionIndex = inlineCompletion == nil ? NSNotFound : [inlineEvents indexOfObject:inlineCompletion];
        check(inlineRequest != nil && inlineCompletion != nil && requestIndex < completionIndex,
            @"an inline start completion is recorded after its request");
        discard();
        method_setImplementation(method, (IMP)holdStart);
        NSArray *sampleStartEvents = capturedEvents(^{ check(start(directory),
            @"the sample-status attempt starts"); });
        NSDictionary *sampleRequest = lifecycleEvent(sampleStartEvents, @"start-request", nil);
        NSString *sampleSession = sampleRequest[@"fields"][@"session"];
        CMSampleBufferRef idle = sampleWithStatus(NO);
        check(idle != NULL, @"the first-sample fixture is created");
        if (idle != NULL) {
            NSArray *sampleEvents = capturedEvents(^{ [captureSink stream:captureStream didOutputSampleBuffer:idle ofType:SCStreamOutputTypeScreen]; });
            CFRelease(idle);
            check(lifecycleMachTickFieldsMatchSchema(sampleEvents),
                @"first-sample lifecycle Mach-tick fields are strings or null");
            NSDictionary *firstSample = lifecycleEvent(sampleEvents, @"first-sample", sampleSession);
            check(firstSample != nil && ![firstSample[@"fields"][@"statusPresent"] boolValue]
                && firstSample[@"fields"][@"status"] == [NSNull null]
                && ![firstSample[@"fields"][@"displayTimePresent"] boolValue]
                && firstSample[@"fields"][@"displayTimeMachTicks"] == [NSNull null],
                @"the first sample trace explicitly preserves missing status and display time");
        }
        discard();
        method_setImplementation(method, (IMP)holdStart);
        NSArray *timeoutStartEvents = capturedEvents(^{ check(start(directory),
            @"the no-first-sample attempt starts"); });
        NSDictionary *timeoutRequest = lifecycleEvent(timeoutStartEvents, @"start-request", nil);
        NSString *timeoutSession = timeoutRequest[@"fields"][@"session"];
        check([[NSFileManager defaultManager] createDirectoryAtPath:[NSString stringWithUTF8String:path]
            withIntermediateDirectories:YES attributes:nil error:NULL], @"the failed-attempt folder exists before wait");
        __block int waited = -1;
        NSArray *failureEvents = capturedEvents(^{ waited = sp_capture_wait(); });
        check(lifecycleMachTickFieldsMatchSchema(failureEvents),
            @"failure lifecycle Mach-tick fields are strings or null");
        check(waited == 0, @"a missing first frame follows the normal capture-wait failure path");
        NSDictionary *failed = lifecycleEvent(failureEvents, @"failed", timeoutSession);
        check(failed != nil && failed[@"fields"][@"stopAfterMilliseconds"] == [NSNull null]
            && failed[@"fields"][@"stopTargetMachTicks"] == [NSNull null]
            && failed[@"fields"][@"stopRegistrationMachTicks"] == [NSNull null]
            && failed[@"fields"][@"latestSampleCallbackMachTicks"] == [NSNull null]
            && ![failed[@"fields"][@"latestSampleStatusPresent"] boolValue]
            && failed[@"fields"][@"latestSampleStatus"] == [NSNull null]
            && ![failed[@"fields"][@"latestSampleDisplayTimePresent"] boolValue]
            && failed[@"fields"][@"latestSampleDisplayTimeMachTicks"] == [NSNull null],
            @"a failure before stop retains explicit null stop and latest-sample facts");
        NSUInteger failureCount = 0;
        for (NSDictionary *event in failureEvents) {
            if ([event[@"name"] isEqual:@"native.capture.lifecycle"]
                && [event[@"fields"][@"phase"] isEqual:@"failed"]
                && [event[@"fields"][@"session"] isEqual:timeoutSession]) failureCount++;
        }
        id factsObserved = failed[@"fields"][@"factsObservedMachTicks"];
        BOOL validFacts = factsObserved == [NSNull null]
            || ([factsObserved isKindOfClass:NSString.class]
                && [failed[@"fields"][@"visible"] isKindOfClass:NSNumber.class]
                && [failed[@"fields"][@"occluded"] isKindOfClass:NSNumber.class]
                && [failed[@"fields"][@"applicationActive"] isKindOfClass:NSNumber.class]);
        check(failed != nil && [failed[@"level"] intValue] == SP_EVENT_ERROR
            && ![failed[@"fields"][@"startCompletionSeen"] boolValue]
            && ![failed[@"fields"][@"firstSampleSeen"] boolValue]
            && ![failed[@"fields"][@"delegateStopSeen"] boolValue]
            && [failed[@"fields"][@"reason"] containsString:@"no capture frame arrived"]
            && [failed[@"fields"][@"machTimebaseNumerator"] unsignedIntValue] > 0
            && [failed[@"fields"][@"machTimebaseDenominator"] unsignedIntValue] > 0
            && failureCount == 1 && validFacts,
            [NSString stringWithFormat:@"the failure summary is in the process event sink before wait returns to folder cleanup (%@)",
                failureEvents]);
        setCaptureError(@"fixture cleanup secondary error");
        NSArray *laterErrors = capturedEvents(^{ });
        check(lifecycleEvent(laterErrors, @"failed", timeoutSession) == nil,
            @"cleanup errors do not emit a second failure summary for the same attempt");
        NSError *removeError = nil;
        check([[NSFileManager defaultManager] removeItemAtPath:[NSString stringWithUTF8String:path] error:&removeError],
            [NSString stringWithFormat:@"the failed-attempt folder is removed after its lifecycle summary (%@)", removeError]);
        discard();
        method_setImplementation(method, originalMethod);
    }
    [starts release]; starts = nil;
    [captureFilter release]; captureFilter = nil; [captureConfig release]; captureConfig = nil;
    [window close]; [window release];
    if (created) {
        NSError *cleanup = nil;
        NSString *fixture = [NSString stringWithUTF8String:path];
        check(![[NSFileManager defaultManager] fileExistsAtPath:fixture]
            || [[NSFileManager defaultManager] removeItemAtPath:fixture error:&cleanup],
            [NSString stringWithFormat:@"the callback fixture is removed (%@)",cleanup]);
    }
    fprintf(stderr,"%s: native delayed stream callback isolation (%d failed assertions, %.1fms)\n",
        failures ? "FAIL" : "PASS",failures,(CACurrentMediaTime()-began)*1000);
    alarm(0); return failures ? 1 : 0;
}}
