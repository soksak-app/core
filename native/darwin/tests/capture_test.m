#import <Cocoa/Cocoa.h>
#import "capture.h"

static int failures;
static void check(BOOL condition, NSString *message) {
    fprintf(condition ? stdout : stderr, "%s: %s\n", condition ? "PASS" : "FAIL", message.UTF8String);
    if (!condition) failures++;
}

int main(void) { @autoreleasepool {
    [NSApplication sharedApplication];
    [NSApp setActivationPolicy:NSApplicationActivationPolicyAccessory];
    [NSApp finishLaunching];
    char directory[] = "/tmp/soksak-capture-test-XXXXXX";
    check(mkdtemp(directory) != NULL, @"a private capture directory is created");
    check(!sp_capture_open(-1, false), @"an invalid window is rejected by the native capture boundary");
    check(sp_capture_error() != NULL && strlen(sp_capture_error()) > 0, @"open failure is observable to the caller");
    check(!sp_capture_start(directory), @"starting without a capture target is rejected");
    check(sp_capture_error() != NULL && strlen(sp_capture_error()) > 0, @"start failure is observable to the caller");
    check(sp_capture_wait() == 0, @"an invalid window cannot produce a capture frame");
    check(sp_capture_stop(0) == 0, @"stopping an invalid capture reports no written frames");
    NSArray *files = [[NSFileManager defaultManager] contentsOfDirectoryAtPath:
        [NSString stringWithUTF8String:directory] error:NULL];
    check(files.count == 0, @"an invalid capture leaves no frame files");
    [[NSFileManager defaultManager] removeItemAtPath:[NSString stringWithUTF8String:directory] error:NULL];
    return failures ? 1 : 0;
}}
