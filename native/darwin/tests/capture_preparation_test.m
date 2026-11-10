// Delivers the real preparation completion late and checks that the caller waits for it, receives its result and releases the
// obsolete target objects. Then ends the preparation wait before its completion and checks that the call returns that end and
// that the completion that arrives afterwards leaves the following recording state and object ownership unchanged.
#import "../src/capture.m"
#import "support/event_wait.h"
#import <objc/runtime.h>

static int failures;
static void check(BOOL condition, NSString *message) {
    fprintf(condition ? stdout : stderr, "%s: %s\n", condition ? "PASS" : "FAIL", message.UTF8String);
    if (!condition) failures++;
}

@interface PreparationOwnerFixture : NSObject
@property (nonatomic, assign) BOOL *released;
@end
@implementation PreparationOwnerFixture
- (void)dealloc { *self.released = YES; [super dealloc]; }
@end

static void (^heldReply)(SCShareableContent *, NSError *);
// Signaled by the held query when the call has handed its completion over and goes on to wait for it.
static dispatch_semaphore_t queryHeld;
static SCShareableContent *collisionContent;
static SCContentFilter *collisionFilter;
static SCStreamConfiguration *collisionConfig;
static void holdQuery(id receiver, SEL selector, void (^reply)(SCShareableContent *, NSError *)) {
    check(heldReply == nil, @"the controlled query has one completion");
    if (collisionContent != nil) {
        // Injects, just before the completion, the state in which another recording starts during the wait.
        captureFilter = collisionFilter; captureConfig = collisionConfig;
        captureStream = (SCStream *)[NSObject new];
        clearCaptureError(); setCaptureError(@"fixture active before publication");
        reply(collisionContent, nil);
        return;
    }
    heldReply = [reply copy];
    if (queryHeld) dispatch_semaphore_signal(queryHeld);
}

int main(void) { @autoreleasepool {
    CFTimeInterval began = CACurrentMediaTime();
    fprintf(stderr, "START: native preparation completion\n");
    [NSApplication sharedApplication];
    [NSApp setActivationPolicy:NSApplicationActivationPolicyAccessory];
    [NSApp finishLaunching];
    NSWindow *window = [[NSWindow alloc] initWithContentRect:NSMakeRect(120, 120, 200, 100)
        styleMask:NSWindowStyleMaskBorderless backing:NSBackingStoreBuffered defer:NO];
    window.releasedWhenClosed = NO;
    window.animationBehavior = NSWindowAnimationBehaviorNone;
    [window orderFrontRegardless];
    // A preparation sizes the recording from the bounds that the window server reports for the window, and the window server
    // has them once it put the window on screen, which the occlusion state reports.
    eventWait(@"the window server shows the fixture window",
        ^BOOL { return (window.occlusionState & NSWindowOcclusionStateVisible) != 0; });
    __block SCShareableContent *content = nil;
    __block NSError *queryError = nil;
    dispatch_semaphore_t ready = dispatch_semaphore_create(0);
    [SCShareableContent getCurrentProcessShareableContentWithCompletionHandler:
        ^(SCShareableContent *result, NSError *error) {
            content = [result retain]; queryError = [error retain]; dispatch_semaphore_signal(ready);
        }];
    // The real query ends by its completion and by nothing else; a query that never completes is reported by the runner.
    dispatch_semaphore_wait(ready, DISPATCH_TIME_FOREVER);
    BOOL answered = YES;
    BOOL hasWindow = NO;
    for (SCWindow *candidate in content.windows) if (candidate.windowID == window.windowNumber) hasWindow = YES;
    check(answered && queryError == nil && hasWindow,
        [NSString stringWithFormat:@"the real query contains the inactive fixture window (%@)", queryError]);
    dispatch_release(ready);
    Method query = class_getClassMethod([SCShareableContent class],
        @selector(getCurrentProcessShareableContentWithCompletionHandler:));
    check(query != NULL, @"the controlled preparation query boundary exists");
    if (answered && queryError == nil && hasWindow && query != NULL) {
        for (int success = 0; success < 2; success++) {
            CFTimeInterval phase = CACurrentMediaTime();
            fprintf(stderr, "START: late preparation %s\n", success ? "success" : "failure");
            BOOL filterReleased = NO, configReleased = NO;
            PreparationOwnerFixture *obsoleteFilter = [PreparationOwnerFixture new];
            PreparationOwnerFixture *obsoleteConfig = [PreparationOwnerFixture new];
            obsoleteFilter.released = &filterReleased; obsoleteConfig.released = &configReleased;
            captureFilter = (SCContentFilter *)obsoleteFilter;
            captureConfig = (SCStreamConfiguration *)obsoleteConfig;
            IMP original = method_setImplementation(query, (IMP)holdQuery);
            // The completion arrives on another queue after the call handed it over; the wait ends by it and by nothing else.
            queryHeld = dispatch_semaphore_create(0);
            dispatch_semaphore_t held = queryHeld;
            dispatch_async(dispatch_get_global_queue(QOS_CLASS_DEFAULT, 0), ^{
                dispatch_semaphore_wait(held, DISPATCH_TIME_FOREVER);
                void (^reply)(SCShareableContent *, NSError *) = heldReply;
                heldReply = nil;
                if (reply == nil) return;
                reply(success ? content : nil, success ? nil :
                    [NSError errorWithDomain:@"capture.test" code:1
                        userInfo:@{NSLocalizedDescriptionKey: @"fixture late preparation failure"}]);
                [reply release];
            });
            char *error = NULL;
            BOOL opened = sp_capture_open(window.windowNumber, false, 1 + 2 * success, &error);
            method_setImplementation(query, original);
            dispatch_release(queryHeld); queryHeld = NULL;
            if (success) {
                check(opened && error == NULL && captureFilter != nil && captureConfig != nil,
                    [NSString stringWithFormat:@"a late successful completion prepares the recording target (%s)", error ?: ""]);
            } else {
                check(!opened && error != NULL && strstr(error, "fixture late preparation failure") != NULL,
                    @"a late failed completion returns its own caller-owned error");
            }
            check(filterReleased && configReleased,
                @"preparation releases both obsolete inactive target objects");
            // Cleans up the leak of the previous store within the test file even in the Red run.
            if (captureFilter == (SCContentFilter *)obsoleteFilter) captureFilter = nil;
            if (captureConfig == (SCStreamConfiguration *)obsoleteConfig) captureConfig = nil;
            if (!filterReleased) [obsoleteFilter release];
            if (!configReleased) [obsoleteConfig release];
            free(error);
            [captureFilter release]; captureFilter = nil;
            [captureConfig release]; captureConfig = nil;
            fprintf(stderr, "END: late preparation %s (%.1fms)\n",
                success ? "success" : "failure", (CACurrentMediaTime() - phase) * 1000);

            fprintf(stderr, "START: ended preparation %s\n", success ? "success" : "failure");
            BOOL endedFilterReleased = NO, endedConfigReleased = NO;
            obsoleteFilter = [PreparationOwnerFixture new];
            obsoleteConfig = [PreparationOwnerFixture new];
            obsoleteFilter.released = &endedFilterReleased; obsoleteConfig.released = &endedConfigReleased;
            captureFilter = (SCContentFilter *)obsoleteFilter;
            captureConfig = (SCStreamConfiguration *)obsoleteConfig;
            original = method_setImplementation(query, (IMP)holdQuery);
            error = NULL;
            // The end comes before the call waits, so the held query is ended without a race.
            uint64_t token = 2 + 2 * success;
            sp_capture_end_wait(token, "the fixture ended the preparation");
            opened = sp_capture_open(window.windowNumber, false, token, &error);
            method_setImplementation(query, original);
            check(!opened && error != NULL && strcmp(error,
                "the shareable content query did not answer before the fixture ended the preparation") == 0,
                [NSString stringWithFormat:@"held preparation returns its owned end (%s)", error]);
            check(endedFilterReleased && endedConfigReleased,
                @"an ended preparation releases both obsolete inactive target objects");
            if (captureFilter == (SCContentFilter *)obsoleteFilter) captureFilter = nil;
            if (captureConfig == (SCStreamConfiguration *)obsoleteConfig) captureConfig = nil;
            if (!endedFilterReleased) [obsoleteFilter release];
            if (!endedConfigReleased) [obsoleteConfig release];
            SCContentFilter *laterFilter = (SCContentFilter *)[NSObject new];
            SCStreamConfiguration *laterConfig = (SCStreamConfiguration *)[NSObject new];
            captureFilter = laterFilter; captureConfig = laterConfig;
            captureStream = (SCStream *)[NSObject new];
            clearCaptureError(); setCaptureError(@"fixture later recording error");
            check(heldReply != nil, @"the ended query retains its completion");
            if (heldReply != nil) {
                heldReply(success ? content : nil, success ? nil :
                    [NSError errorWithDomain:@"capture.test" code:1
                        userInfo:@{NSLocalizedDescriptionKey: @"fixture late preparation failure"}]);
                [heldReply release]; heldReply = nil;
            }
            check(strcmp(sp_capture_error(), "fixture later recording error") == 0,
                @"a late preparation completion preserves the exact later recording error");
            check(captureFilter == laterFilter && captureConfig == laterConfig,
                @"a late preparation completion preserves the later target and configuration");
            check(error != NULL && strstr(error, "before the fixture ended the preparation") != NULL,
                @"the returned preparation end remains caller-owned");
            free(error);
            if (captureFilter != laterFilter) [captureFilter release];
            if (captureConfig != laterConfig) [captureConfig release];
            captureFilter = nil; captureConfig = nil;
            [laterFilter release]; [laterConfig release];
            [captureStream release]; captureStream = nil;
            fprintf(stderr, "END: ended preparation %s\n", success ? "success" : "failure");
        }
    }
    if (answered && queryError == nil && hasWindow && query != NULL) {
        fprintf(stderr, "START: active recording before preparation publication\n");
        collisionContent = content;
        collisionFilter = (SCContentFilter *)[NSObject new];
        collisionConfig = (SCStreamConfiguration *)[NSObject new];
        IMP original = method_setImplementation(query, (IMP)holdQuery);
        char *error = NULL;
        BOOL opened = sp_capture_open(window.windowNumber, false, 0, &error);
        method_setImplementation(query, original);
        check(!opened && error != NULL && strstr(error, "active during preparation") != NULL,
            @"preparation rejects a recording activated before publication");
        check(captureFilter == collisionFilter && captureConfig == collisionConfig,
            @"on-time preparation preserves the newly active recording target");
        check(strcmp(sp_capture_error(), "fixture active before publication") == 0,
            @"on-time preparation preserves the newly active recording error");
        free(error);
        if (captureFilter != collisionFilter) [captureFilter release];
        if (captureConfig != collisionConfig) [captureConfig release];
        captureFilter = nil; captureConfig = nil;
        [collisionFilter release]; [collisionConfig release];
        collisionContent = nil; collisionFilter = nil; collisionConfig = nil;
        [captureStream release]; captureStream = nil;
        fprintf(stderr, "END: active recording before preparation publication\n");
    }
    [content release]; [queryError release];
    [window close]; [window release];
    fprintf(stderr, "%s: native preparation completion (%.1fms)\n",
        failures ? "FAIL" : "PASS", (CACurrentMediaTime() - began) * 1000);
    return failures ? 1 : 0;
}}
