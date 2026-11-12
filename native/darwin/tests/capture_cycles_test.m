// Starts and stops the recording of an inactive window repeatedly in one process. The window check stops the
// recording of each theme as soon as it starts, so this creates a sequence that an acceptance check running
// only one cycle cannot create. Each cycle records its start, its first still, its stop and its counts, and the
// next cycle starts only after the previous one ended. It does not activate the application.
#import "../src/capture.m"
#import "support/temporary_folder.h"
#import "support/run_until.h"

static const int CYCLES = 24;
static CFTimeInterval began;
static int failures;

static void record(NSString *event, int cycle, NSString *detail) {
    fprintf(stderr, "LIFECYCLE +%.3fms cycle=%d %s %s\n", (CACurrentMediaTime() - began) * 1000, cycle, event.UTF8String,
        detail.UTF8String ?: "");
}

static void check(BOOL condition, NSString *message) {
    fprintf(condition ? stdout : stderr, "%s: %s\n", condition ? "PASS" : "FAIL", message.UTF8String);
    if (!condition) failures++;
}

int main(void) { @autoreleasepool {
    began = CACurrentMediaTime();
    [NSApplication sharedApplication];
    [NSApp setActivationPolicy:NSApplicationActivationPolicyAccessory];
    [NSApp finishLaunching];
    NSWindow *window = [[NSWindow alloc] initWithContentRect:NSMakeRect(80, 80, 200, 100)
        styleMask:NSWindowStyleMaskBorderless backing:NSBackingStoreBuffered defer:NO];
    [window setReleasedWhenClosed:NO];
    window.animationBehavior = NSWindowAnimationBehaviorNone;
    window.backgroundColor = NSColor.redColor;
    [window orderFrontRegardless];
    BOOL (^onScreen)(void) = ^BOOL {
        NSArray *info = [(NSArray *)CGWindowListCopyWindowInfo(kCGWindowListOptionIncludingWindow,
            (CGWindowID)window.windowNumber) autorelease];
        return info.count == 1 && [info[0][(id)kCGWindowIsOnscreen] boolValue];
    };
    // As in the acceptance check, do not change the window until the window server has composited its first frame: its
    // occlusion state becomes visible then, in a notification on the main thread.
    sp_run_until("the window is visible", ^BOOL { return (window.occlusionState & NSWindowOcclusionStateVisible) != 0; });
    check(onScreen(), @"the window server shows the capture window");

    NSArray<NSColor *> *colors = @[NSColor.redColor, NSColor.blueColor, NSColor.greenColor];
    int completed = 0;
    NSString *folder = temporaryFolder(@"soksak-capture-cycles-");
    for (int cycle = 1; cycle <= CYCLES && failures == 0; cycle++) {
        // As in the window check, change the window content each cycle.
        window.backgroundColor = colors[cycle % colors.count];
        [window display];
        NSString *directory = [folder stringByAppendingPathComponent:[NSString stringWithFormat:@"cycle-%d", cycle]];
        NSError *createError = nil;
        if (![[NSFileManager defaultManager] createDirectoryAtPath:directory withIntermediateDirectories:NO attributes:nil error:&createError]) {
            check(NO, [NSString stringWithFormat:@"cycle %d creates a capture directory (%@)", cycle, createError]);
            break;
        }
        char *operationError = NULL;
        bool opened = sp_capture_open(window.windowNumber, false, &operationError);
        check(opened, [NSString stringWithFormat:@"cycle %d opens the window for recording (%s)", cycle,
            operationError == NULL ? "" : operationError]);
        free(operationError); operationError = NULL;
        if (!opened) break;
        // The start answers once still 0 is written, and the stop at once requests no later still.
        record(@"start", cycle, nil);
        bool recording = sp_capture_start(directory.fileSystemRepresentation, 1000.0 / 60, 0, 4096, 0, &operationError);
        check(recording, [NSString stringWithFormat:@"cycle %d starts recording with its first still (%s)", cycle,
            operationError == NULL ? "" : operationError]);
        free(operationError);
        if (recording) {
            check([[NSFileManager defaultManager] fileExistsAtPath:[directory stringByAppendingPathComponent:@"frame-0000.bgra"]],
                [NSString stringWithFormat:@"cycle %d writes still 0 before the start answers", cycle]);
            record(@"first-still", cycle, nil);
            int frames = sp_capture_stop(0, 0);
            record(@"stop", cycle, [NSString stringWithFormat:@"written=%d missed=%d late=%d", frames, sp_capture_missed(),
                sp_capture_late()]);
            // The error string is shared state, so use the same copy for the verdict and the report.
            const char *stopError = sp_capture_error();
            NSString *stopText = stopError == NULL ? nil : [NSString stringWithUTF8String:stopError];
            check(stopText != nil && stopText.length == 0 && frames > 0 && frames + sp_capture_missed() == 4096,
                [NSString stringWithFormat:@"cycle %d stops without error and accounts for every planned still (frames %d, missed %d, "
                    "error %@)", cycle, frames, sp_capture_missed(), stopText]);
            check(!recordingActive(), [NSString stringWithFormat:@"cycle %d ends its recording before the next cycle", cycle]);
            if (failures == 0) completed++;
        }
        NSError *removeError = nil;
        if ([[NSFileManager defaultManager] fileExistsAtPath:directory]
            && ![[NSFileManager defaultManager] removeItemAtPath:directory error:&removeError]) {
            check(NO, [NSString stringWithFormat:@"cycle %d removes its frames (%@)", cycle, removeError]);
        }
    }
    check(!NSApp.isActive, @"recording cycles do not activate the application");
    [window close];
    [window release];
    fprintf(stderr, "%s: %d of %d consecutive recording cycles (%.1fms)\n",
        failures ? "FAIL" : "PASS", completed, CYCLES, (CACurrentMediaTime() - began) * 1000);
    return failures ? 1 : 0;
}}
