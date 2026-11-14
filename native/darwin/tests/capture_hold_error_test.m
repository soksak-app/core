// The error of the wait for a held window (sp_capture_hold_new_window, sp_capture_wait_new_window): a wait that fails reports its own
// failure, and the hold that begins the next wait begins it without the failures of the earlier waits, so the error that the second of
// two failed waits reports names only the second failure.
#import "../src/capture.m"
#import "../src/window_reveal.h"
#import "support/event_wait.h"

static int failures;
static void check(BOOL condition, NSString *message) {
    fprintf(condition ? stdout : stderr, "%s: %s\n", condition ? "PASS" : "FAIL", message.UTF8String);
    if (!condition) failures++;
}

// Runs call on a thread of its own, as a host runs the native calls that wait, and waits on the main thread until it returned.
// The result is set by a block of the main queue, so the blocks that the call queued on the main queue before it returned run first.
static void offMain(NSString *what, void (^call)(void)) {
    __block BOOL returned = NO;
    dispatch_async(dispatch_get_global_queue(QOS_CLASS_USER_INITIATED, 0), ^{
        call();
        dispatch_async(dispatch_get_main_queue(), ^{ returned = YES; });
    });
    eventWait(what, ^BOOL { return returned; });
}

// Sets a hold, ends the wait of the token with end, runs the wait, and returns the error that the native library reports for it.
static NSString *failedWait(uint64_t token, const char *end, long *result) {
    char *error = NULL;
    bool held = sp_capture_hold_new_window(&error);
    free(error);
    check(held, [NSString stringWithFormat:@"the hold of the wait for %s is set", end]);
    sp_capture_end_wait(token, end);
    __block long number = 0;
    __block NSString *reported = nil;
    offMain([NSString stringWithFormat:@"the wait ended by %s", end], ^{
        number = sp_capture_wait_new_window(token);
        reported = [[NSString stringWithUTF8String:sp_capture_error() ?: ""] retain];
    });
    *result = number;
    return [reported autorelease];
}

int main(void) { @autoreleasepool {
    [NSApplication sharedApplication];
    [NSApp setActivationPolicy:NSApplicationActivationPolicyAccessory];
    [NSApp finishLaunching];

    long first = 0, second = 0;
    NSString *firstError = failedWait(1, "the end of the first request", &first);
    check(first < 0 && [firstError isEqualToString:@"no new window was shown before the end of the first request"],
        [NSString stringWithFormat:@"the first wait fails with its end (%ld, %@)", first, firstError]);
    NSString *secondError = failedWait(2, "the end of the second request", &second);
    check(second < 0 && [secondError isEqualToString:@"no new window was shown before the end of the second request"],
        [NSString stringWithFormat:@"the second wait reports only its own failure (%ld, %@)", second, secondError]);

    if (failures) fprintf(stderr, "%d failures\n", failures);
    return failures ? 1 : 0;
} }
