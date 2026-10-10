// Holds the start completion of a stream that was actually created and delivers it after replacement, to
// check error ownership.
#import "../src/capture.m"
#import "support/records.h"
#import <objc/runtime.h>
#include <signal.h>
#include <unistd.h>

static int failures;
static NSMutableArray *starts;
static void check(BOOL condition, NSString *message) {
    fprintf(stderr, "%s: %s\n", condition ? "PASS" : "FAIL", message.UTF8String);
    if (!condition) failures++;
}
static void expired(int signalNumber) {
    const char message[] = "FAIL: capture callback test exceeded 15000ms\n";
    write(STDERR_FILENO, message, sizeof message - 1); _exit(1);
}
static void holdStart(id stream, SEL selector, void (^reply)(NSError *)) {
    [starts addObject:[[reply copy] autorelease]];
}
static NSError *fault(NSString *message) {
    return [NSError errorWithDomain:@"capture.test" code:1 userInfo:@{NSLocalizedDescriptionKey:message}];
}
static BOOL start(NSString *directory) {
    char *error = NULL;
    BOOL started = sp_capture_start(directory.UTF8String, &error);
    check(started && error == NULL,
        [NSString stringWithFormat:@"the real stream registers its output before controlled completion (%s)", error]);
    free(error); return started;
}
static void discard(void) {
    // Release only the stream and queue of the ownership fault injection that did not actually start
    // a recording.
    [captureStream release]; captureStream = nil;
    if (captureQueue != NULL) { dispatch_release(captureQueue); captureQueue = NULL; }
}
int main(void) { @autoreleasepool {
    signal(SIGALRM, expired); alarm(15);
    CFTimeInterval began = CACurrentMediaTime();
    fprintf(stderr, "START: native delayed stream callback isolation\n");
    [NSApplication sharedApplication]; [NSApp setActivationPolicy:NSApplicationActivationPolicyAccessory];
    [NSApp finishLaunching];
    NSWindow *window = [[NSWindow alloc] initWithContentRect:NSMakeRect(120,120,200,100)
        styleMask:NSWindowStyleMaskBorderless backing:NSBackingStoreBuffered defer:NO];
    window.releasedWhenClosed = NO; window.animationBehavior = NSWindowAnimationBehaviorNone;
    [window orderFrontRegardless];
    char path[] = "/tmp/soksak-capture-callback-XXXXXX";
    BOOL created = mkdtemp(path) != NULL;
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
        NSString *directory = [NSString stringWithUTF8String:path];
        for (int failed = 0; failed < 2; failed++) {
            CFTimeInterval phase = CACurrentMediaTime();
            fprintf(stderr, "START: delayed callback with %s current recording\n", failed ? "failed" : "healthy");
            [starts removeAllObjects];
            if (!start(directory)) { discard(); continue; }
            SCStream *old = [captureStream retain];
            discard();
            if (!start(directory)) { discard(); [old release]; continue; }
            SCStream *current = captureStream;
            check(current != old && starts.count == 2, @"the controlled records have distinct real stream identities");
            if (starts.count == 2) {
                if (failed) setCaptureError(@"fixture current recording error");
                NSString *observed = capturedRecords(^{
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
                fprintf(stderr, "%s", observed.UTF8String);
                check([observed containsString:@"fixture late start failure"] && [observed containsString:@"fixture late delegate failure"],
                    @"both late errors are reported instead of silently discarded");
                check(captureStream == current, @"late callbacks preserve the replacement stream");
                void (^currentStart)(NSError *) = starts[1];
                currentStart(fault(@"fixture active start failure"));
                check(strstr(sp_capture_error(),"fixture active start failure") != NULL,
                    @"the current start failure still changes its recording error");
                [captureSink stream:current didStopWithError:fault(@"fixture active delegate failure")];
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
    [starts release]; starts = nil;
    [captureFilter release]; captureFilter = nil; [captureConfig release]; captureConfig = nil;
    [window close]; [window release];
    if (created) {
        NSError *cleanup = nil;
        check([[NSFileManager defaultManager] removeItemAtPath:[NSString stringWithUTF8String:path] error:&cleanup],
            [NSString stringWithFormat:@"the callback fixture is removed (%@)",cleanup]);
    }
    fprintf(stderr,"%s: native delayed stream callback isolation (%d failed assertions, %.1fms)\n",
        failures ? "FAIL" : "PASS",failures,(CACurrentMediaTime()-began)*1000);
    alarm(0); return failures ? 1 : 0;
}}
