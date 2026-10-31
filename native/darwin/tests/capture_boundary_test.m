// Checks the boundary of the native capture without a display: an invalid window is rejected, a start without a prepared
// target is rejected, and a capture that never started writes no frame. The recording of a real window is checked by
// capture_test, which needs a display that presents frames.
#import <Cocoa/Cocoa.h>
#import "capture.h"
#import "support/temporary_folder.h"

static int failures;
static void check(BOOL condition, NSString *message) {
    fprintf(condition ? stdout : stderr, "%s: %s\n", condition ? "PASS" : "FAIL", message.UTF8String);
    if (!condition) failures++;
}

#import "support/capture_boundary.m"

int main(void) { @autoreleasepool {
    [NSApplication sharedApplication];
    [NSApp setActivationPolicy:NSApplicationActivationPolicyAccessory];
    [NSApp finishLaunching];
    checkCaptureBoundary(temporaryFolder(@"soksak-capture-boundary-").fileSystemRepresentation);
    if (failures) fprintf(stderr, "%d failures\n", failures);
    return failures ? 1 : 0;
}}
