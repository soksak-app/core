// 실제 준비 완료를 시간 초과 뒤 전달하여 이후 녹화 상태와 객체 소유를 검사한다.
#import "../src/capture.m"
#import <objc/runtime.h>
#include <signal.h>
#include <unistd.h>

static volatile sig_atomic_t phaseIndex;
static void expired(int signalNumber) {
    const char provider[] = "FAIL: preparation test exceeded 35000ms during the real query\n";
    const char failure[] = "FAIL: preparation test exceeded 35000ms during the late failure\n";
    const char success[] = "FAIL: preparation test exceeded 35000ms during the late success\n";
    if (phaseIndex == 0) write(STDERR_FILENO, provider, sizeof provider - 1);
    else if (phaseIndex == 1) write(STDERR_FILENO, failure, sizeof failure - 1);
    else write(STDERR_FILENO, success, sizeof success - 1);
    _exit(1);
}

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
static SCShareableContent *collisionContent;
static SCContentFilter *collisionFilter;
static SCStreamConfiguration *collisionConfig;
static void holdQuery(id receiver, SEL selector, void (^reply)(SCShareableContent *, NSError *)) {
    check(heldReply == nil, @"the controlled query has one completion");
    if (collisionContent != nil) {
        // 대기 중 다른 녹화가 시작되는 상태를 완료 직전에 주입한다.
        captureFilter = collisionFilter; captureConfig = collisionConfig;
        captureStream = (SCStream *)[NSObject new];
        clearCaptureError(); setCaptureError(@"fixture active before publication");
        reply(collisionContent, nil);
        return;
    }
    heldReply = [reply copy];
}

int main(void) { @autoreleasepool {
    signal(SIGALRM, expired); alarm(35);
    CFTimeInterval began = CACurrentMediaTime();
    fprintf(stderr, "START: native preparation timeout isolation\n");
    [NSApplication sharedApplication];
    [NSApp setActivationPolicy:NSApplicationActivationPolicyAccessory];
    [NSApp finishLaunching];
    NSWindow *window = [[NSWindow alloc] initWithContentRect:NSMakeRect(120, 120, 200, 100)
        styleMask:NSWindowStyleMaskBorderless backing:NSBackingStoreBuffered defer:NO];
    window.releasedWhenClosed = NO;
    window.animationBehavior = NSWindowAnimationBehaviorNone;
    [window orderFrontRegardless];
    __block SCShareableContent *content = nil;
    __block NSError *queryError = nil;
    dispatch_semaphore_t ready = dispatch_semaphore_create(0);
    [SCShareableContent getCurrentProcessShareableContentWithCompletionHandler:
        ^(SCShareableContent *result, NSError *error) {
            content = [result retain]; queryError = [error retain]; dispatch_semaphore_signal(ready);
        }];
    BOOL answered = dispatch_semaphore_wait(ready, dispatch_time(DISPATCH_TIME_NOW, 10 * NSEC_PER_SEC)) == 0;
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
            phaseIndex = success ? 2 : 1;
            CFTimeInterval phase = CACurrentMediaTime();
            fprintf(stderr, "START: late preparation %s\n", success ? "success" : "failure");
            BOOL filterReleased = NO, configReleased = NO;
            PreparationOwnerFixture *obsoleteFilter = [PreparationOwnerFixture new];
            PreparationOwnerFixture *obsoleteConfig = [PreparationOwnerFixture new];
            obsoleteFilter.released = &filterReleased; obsoleteConfig.released = &configReleased;
            captureFilter = (SCContentFilter *)obsoleteFilter;
            captureConfig = (SCStreamConfiguration *)obsoleteConfig;
            IMP original = method_setImplementation(query, (IMP)holdQuery);
            char *error = NULL;
            BOOL opened = sp_capture_open(window.windowNumber, false, &error);
            method_setImplementation(query, original);
            double waited = (CACurrentMediaTime() - phase) * 1000;
            check(waited >= 10000, [NSString stringWithFormat:
                @"held preparation waits for its 10000ms deadline (%.3fms)", waited]);
            check(!opened && error != NULL && strstr(error, "timed out after 10000ms") != NULL,
                @"held preparation returns an explicit owned timeout");
            check(filterReleased && configReleased,
                @"preparation releases both obsolete inactive target objects");
            // Red에서도 이전 저장소의 누수를 검사 파일 안에서 정리한다.
            if (captureFilter == (SCContentFilter *)obsoleteFilter) captureFilter = nil;
            if (captureConfig == (SCStreamConfiguration *)obsoleteConfig) captureConfig = nil;
            if (!filterReleased) [obsoleteFilter release];
            if (!configReleased) [obsoleteConfig release];
            SCContentFilter *laterFilter = (SCContentFilter *)[NSObject new];
            SCStreamConfiguration *laterConfig = (SCStreamConfiguration *)[NSObject new];
            captureFilter = laterFilter; captureConfig = laterConfig;
            captureStream = (SCStream *)[NSObject new];
            clearCaptureError(); setCaptureError(@"fixture later recording error");
            check(heldReply != nil, @"the timed-out query retains its completion");
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
            check(error != NULL && strstr(error, "timed out after 10000ms") != NULL,
                @"the returned preparation timeout remains caller-owned");
            free(error);
            if (captureFilter != laterFilter) [captureFilter release];
            if (captureConfig != laterConfig) [captureConfig release];
            captureFilter = nil; captureConfig = nil;
            [laterFilter release]; [laterConfig release];
            [captureStream release]; captureStream = nil;
            fprintf(stderr, "END: late preparation %s (%.1fms)\n",
                success ? "success" : "failure", (CACurrentMediaTime() - phase) * 1000);
        }
    }
    if (answered && queryError == nil && hasWindow && query != NULL) {
        phaseIndex = 2;
        fprintf(stderr, "START: active recording before preparation publication\n");
        collisionContent = content;
        collisionFilter = (SCContentFilter *)[NSObject new];
        collisionConfig = (SCStreamConfiguration *)[NSObject new];
        IMP original = method_setImplementation(query, (IMP)holdQuery);
        char *error = NULL;
        BOOL opened = sp_capture_open(window.windowNumber, false, &error);
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
    fprintf(stderr, "%s: native preparation timeout isolation (%.1fms)\n",
        failures ? "FAIL" : "PASS", (CACurrentMediaTime() - began) * 1000);
    alarm(0);
    return failures ? 1 : 0;
}}
