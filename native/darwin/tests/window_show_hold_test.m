// The recording of a new window from its first still (sp_capture_hold_new_window): the hold of the next show of a window that is
// not on screen, the preparation of its recording while it is off the screen, the start that puts it on screen and takes still
// 0 at the window's device-pixel size, and each end of the hold, after which the window goes on screen. A show without a hold
// is unchanged.
#import "../src/capture.m"
#import "../src/window_reveal.h"
#import "support/event_wait.h"
#import "support/temporary_folder.h"
#include <dlfcn.h>

static int failures;
static void check(BOOL condition, NSString *message) {
    fprintf(condition ? stdout : stderr, "%s: %s\n", condition ? "PASS" : "FAIL", message.UTF8String);
    if (!condition) failures++;
}

static NSWindow *makeWindow(void) {
    NSWindow *window = [[NSWindow alloc] initWithContentRect:NSMakeRect(140, 140, 220, 120)
        styleMask:NSWindowStyleMaskBorderless backing:NSBackingStoreBuffered defer:NO];
    window.releasedWhenClosed = NO;
    window.animationBehavior = NSWindowAnimationBehaviorNone;
    window.backgroundColor = [NSColor colorWithSRGBRed:1 green:0 blue:0 alpha:1];
    return window;
}

// Whether the window server lists the window on screen with its bounds.
static BOOL listed(NSWindow *window) {
    NSArray *info = [(NSArray *)CGWindowListCopyWindowInfo(kCGWindowListOptionIncludingWindow,
        (CGWindowID)window.windowNumber) autorelease];
    return info.count == 1 && [info[0][(id)kCGWindowIsOnscreen] boolValue] && info[0][(id)kCGWindowBounds] != nil;
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

static NSString *taken(char *error) {
    NSString *text = error ? [NSString stringWithUTF8String:error] : @"";
    free(error);
    return text;
}

// A window server that gives no image, as a still of the start that fails: the lookup of the capture returns this function in
// place of CGWindowListCreateImageFromArray while failStill is set.
static BOOL failStill;
static CGImageRef noImage(CGRect rect, CFArrayRef windows, CGWindowImageOption options) {
    (void)rect; (void)windows; (void)options;
    return NULL;
}
static void *lookupFailingStill(void *handle, const char *name) {
    if (failStill && strcmp(name, "CGWindowListCreateImageFromArray") == 0) return (void *)noImage;
    return dlsym(handle, name);
}

// The width and height of a recorded frame, from the uint32 values at the start of its file.
static BOOL frameSize(NSString *path, uint32_t size[2]) {
    NSData *data = [NSData dataWithContentsOfFile:path];
    if (data.length < 2 * sizeof(uint32_t)) return NO;
    [data getBytes:size length:2 * sizeof(uint32_t)];
    return YES;
}

int main(void) { @autoreleasepool {
    [NSApplication sharedApplication];
    [NSApp setActivationPolicy:NSApplicationActivationPolicyAccessory];
    [NSApp finishLaunching];
    captureLookup = lookupFailingStill;
    uint64_t token = 1;

    // A show without a hold puts the window on screen when it returns, as before the hold existed.
    NSWindow *plain = makeWindow();
    sp_window_show(plain);
    check(plain.isVisible, @"a window shown without a hold is on screen when the show returns");
    [plain close];

    // A held show leaves the window off the screen; the recording opens on it there, and its start puts it on screen and takes
    // still 0 in the same main-thread step, so still 0 is the first content of the window.
    char *error = NULL;
    check(sp_capture_hold_new_window(&error), [NSString stringWithFormat:@"the hold of a new window is set (%@)", taken(error)]);
    error = NULL;
    check(!sp_capture_hold_new_window(&error) && error != NULL,
        [NSString stringWithFormat:@"a second hold is refused while one is set (%@)", taken(error)]);
    NSWindow *held = makeWindow();
    sp_window_show(held);
    check(!held.isVisible, @"the held show leaves the window off the screen");
    NSWindow *other = makeWindow();
    sp_window_show(other);
    check(other.isVisible, @"a show after the held one is not held");
    [other close];
    __block long number = -1;
    uint64_t holdToken = token++;
    offMain(@"the held window is reported", ^{ number = sp_capture_wait_new_window(holdToken); });
    check(number == held.windowNumber, [NSString stringWithFormat:@"the wait reports the held window (%ld, window %ld)",
        number, (long)held.windowNumber]);
    __block bool opened = false;
    __block NSString *openError = nil;
    offMain(@"the recording of the held window is prepared", ^{
        char *failure = NULL;
        opened = sp_capture_open(number, false, &failure);
        openError = [taken(failure) retain];
    });
    check(opened, [NSString stringWithFormat:@"the window off the screen is prepared for recording (%@)", openError]);
    check(!held.isVisible, @"the preparation leaves the held window off the screen");
    NSString *directory = temporaryFolder(@"soksak-window-show-hold-");
    for (NSString *name in @[@"frames", @"refused"]) {
        [NSFileManager.defaultManager createDirectoryAtPath:[directory stringByAppendingPathComponent:name]
            withIntermediateDirectories:NO attributes:nil error:nil];
    }
    NSString *frames = [directory stringByAppendingPathComponent:@"frames"];
    __block bool started = false;
    __block NSString *startError = nil;
    uint64_t startToken = token++;
    offMain(@"the start of the recording of the held window", ^{
        char *failure = NULL;
        started = sp_capture_start(frames.fileSystemRepresentation, 1000.0 / 60, 0, 4096, startToken, &failure);
        startError = [taken(failure) retain];
    });
    check(started, [NSString stringWithFormat:@"the recording of the held window starts with its first still (%@)", startError]);
    check(held.isVisible && listed(held),
        @"the start put the held window on screen, and the window server lists it with its bounds");
    size_t width = (size_t)(NSWidth(held.frame) * held.backingScaleFactor);
    size_t height = (size_t)(NSHeight(held.frame) * held.backingScaleFactor);
    uint32_t size[2] = {0, 0};
    BOOL sized = frameSize([frames stringByAppendingPathComponent:@"frame-0000.bgra"], size);
    check(sized && size[0] == width && size[1] == height, [NSString stringWithFormat:
        @"still 0 of the held window has the device-pixel size of the window (%ux%u, window %zux%zu)", size[0], size[1],
        width, height]);
    __block int written = 0;
    uint64_t stopToken = token++;
    offMain(@"the stop of the recording", ^{ written = sp_capture_stop(0, stopToken); });
    check(written > 0, [NSString stringWithFormat:@"the recording of the held window has frames (%d)", written]);
    [held close];

    // The end of the wait for a held window ends the hold: the wait fails with that end, and the next show is not held.
    error = NULL;
    check(sp_capture_hold_new_window(&error), [NSString stringWithFormat:@"a new hold is set after the recording (%@)", taken(error)]);
    __block long ended = 0;
    __block NSString *endedError = nil;
    uint64_t endedToken = token++;
    sp_capture_end_wait(endedToken, "the end of the test request");
    offMain(@"the ended wait for a held window", ^{
        ended = sp_capture_wait_new_window(endedToken);
        endedError = [[NSString stringWithUTF8String:sp_capture_error() ?: ""] retain];
    });
    check(ended < 0 && [endedError isEqualToString:@"no new window was shown before the end of the test request"],
        [NSString stringWithFormat:@"the ended wait fails with its end (%ld, %@)", ended, endedError]);
    NSWindow *afterEnd = makeWindow();
    sp_window_show(afterEnd);
    check(afterEnd.isVisible, @"the show after an ended hold is not held");
    [afterEnd close];

    // The release of a hold puts a held window on screen, as the host releases it when the recording fails before its
    // start, and releases a hold that no show took.
    error = NULL;
    check(sp_capture_hold_new_window(&error), [NSString stringWithFormat:@"a hold is set for its release (%@)", taken(error)]);
    NSWindow *released = makeWindow();
    sp_window_show(released);
    check(!released.isVisible, @"the window of the released hold is held first");
    sp_capture_release_new_window();
    check(released.isVisible && listed(released),
        @"the release puts the held window on screen, and the window server lists it with its bounds");
    [released close];
    error = NULL;
    check(sp_capture_hold_new_window(&error), [NSString stringWithFormat:@"a hold is set that no show takes (%@)", taken(error)]);
    sp_capture_release_new_window();
    NSWindow *unheld = makeWindow();
    sp_window_show(unheld);
    check(unheld.isVisible, @"the show after the release of an untaken hold is not held");
    [unheld close];

    // A still 0 that fails still puts the held window on screen, and the start fails with the error of that still.
    error = NULL;
    check(sp_capture_hold_new_window(&error), [NSString stringWithFormat:@"a hold is set for a failed still (%@)", taken(error)]);
    NSWindow *refused = makeWindow();
    sp_window_show(refused);
    __block long refusedNumber = -1;
    uint64_t refusedHold = token++;
    offMain(@"the window of the failed still is reported", ^{ refusedNumber = sp_capture_wait_new_window(refusedHold); });
    __block bool refusedOpened = false, refusedStarted = true;
    __block NSString *refusedStartError = nil;
    uint64_t refusedStart = token++;
    offMain(@"the failed still 0 of the held window", ^{
        char *failure = NULL;
        refusedOpened = sp_capture_open(refusedNumber, false, &failure);
        free(failure);
        failure = NULL;
        if (refusedOpened) {
            failStill = YES;
            refusedStarted = sp_capture_start([directory stringByAppendingPathComponent:@"refused"].fileSystemRepresentation,
                1000.0 / 60, 0, 4096, refusedStart, &failure);
            failStill = NO;
            refusedStartError = [taken(failure) retain];
        }
    });
    NSString *want = [NSString stringWithFormat:@"the window server gave no image of window %ld", refusedNumber];
    NSString *refusedError = [NSString stringWithUTF8String:sp_capture_error() ?: ""];
    check(refusedOpened && !refusedStarted && [refusedStartError isEqualToString:want] && [refusedError containsString:want],
        [NSString stringWithFormat:@"the start fails with the error of its still 0 (start %@, recording %@)", refusedStartError,
            refusedError]);
    check(refused.isVisible && listed(refused), @"a failed still 0 puts the held window on screen");
    [refused close];

    if (failures) fprintf(stderr, "%d failures\n", failures);
    return failures ? 1 : 0;
} }
