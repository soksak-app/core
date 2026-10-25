// Injects a positive frame count and an end error into the actual argument check to verify that no wrong
// pass occurs.
#import <Cocoa/Cocoa.h>
#import "capture.h"

static BOOL faultApplied;
static BOOL faultPending;
static int stopWithError(double after) {
    int frames = sp_capture_stop(after);
    if (frames > 0 && !faultApplied) {
        faultApplied = YES;
        faultPending = YES;
    }
    return frames;
}
static const char *controlledError(void) {
    if (faultPending) {
        faultPending = NO;
        return "fixture recording stop error";
    }
    return sp_capture_error();
}

#define sp_capture_stop stopWithError
#define sp_capture_error controlledError
#define main captureAcceptanceMain
#import "capture_test.m"
#undef main
#undef sp_capture_error
#undef sp_capture_stop

int main(void) {
    CFTimeInterval began = CACurrentMediaTime();
    fprintf(stderr, "START: native capture stop-error checker\n");
    int result = captureAcceptanceMain();
    BOOL rejected = faultApplied && result != 0 && failures == 1;
    fprintf(stderr,
        "%s: capture acceptance rejects a positive frame count with a stop error (fault=%d, result=%d, failures=%d, %.1fms)\n",
        rejected ? "PASS" : "FAIL", faultApplied, result, failures, (CACurrentMediaTime() - began) * 1000);
    return rejected ? 0 : 1;
}
