// Checks, with a window recording that the window server showed, that a title bar height changed while the layout
// transaction (surfaceLayoutBegin) of the window is open does not appear on screen before the commit and appears
// after the commit. The page changes the title bar height in the transaction of the frame in which it draws the new
// first row, so the window buttons must move in the same frame as that commit. The check does not activate the
// application.
#import <Cocoa/Cocoa.h>
#import <QuartzCore/QuartzCore.h>
#import "surface_layout.h"
#import "window_controls.h"
#import "capture.h"
#import "support/capture_frame.m"

// The number of display refreshes to wait while the transaction is open and after the commit.
static const int kRefreshes = 12;

static int failures = 0;

static void check(BOOL condition, NSString *message) {
    fprintf(condition ? stdout : stderr, "%s: %s\n", condition ? "PASS" : "FAIL", message.UTF8String);
    if (!condition) failures++;
}

// Leaves no recording file even if the process is terminated by a callback timeout.
static NSString *recordingDirectory;
static void cleanupRecording(void) {
    if (recordingDirectory == nil) return;
    NSError *error = nil;
    if (![[NSFileManager defaultManager] removeItemAtPath:recordingDirectory error:&error])
        fprintf(stderr, "FAIL: title bar recording cleanup: %s\n", error.localizedDescription.UTF8String);
    [recordingDirectory release]; recordingDirectory = nil;
}

static void until(BOOL (^done)(void)) {
    NSDate *deadline = [NSDate dateWithTimeIntervalSinceNow:10];
    while (!done() && deadline.timeIntervalSinceNow > 0) {
        [[NSRunLoop currentRunLoop] runMode:NSDefaultRunLoopMode
                               beforeDate:[NSDate dateWithTimeIntervalSinceNow:0.01]];
    }
    if (!done()) { fprintf(stderr, "FAIL: the display did not refresh within 10 seconds\n"); exit(1); }
}

// Counts a fixed number of display refreshes.
@interface SPFrames : NSObject
@property int left;
- (void)tick:(CADisplayLink *)link;
@end
@implementation SPFrames
- (void)tick:(CADisplayLink *)link {
    if (--self.left == 0) [link invalidate];
}
@end

// Runs the run loop for count display refreshes. The layout and display cycle of AppKit also runs meanwhile. Returns
// the elapsed time (ms).
static double waitFrames(NSScreen *screen, int count) {
    double start = CACurrentMediaTime() * 1000;
    SPFrames *frames = [[SPFrames new] autorelease];
    frames.left = count;
    [[screen displayLinkWithTarget:frames selector:@selector(tick:)]
        addToRunLoop:NSRunLoop.mainRunLoop forMode:NSRunLoopCommonModes];
    until(^BOOL { return frames.left == 0; });
    return CACurrentMediaTime() * 1000 - start;
}

// A window like the windows of both hosts: the title bar is hidden and the content fills the whole window. It has no
// toolbar. The content is painted with one color so that only the buttons remain in a different color.
static NSWindow *hostLikeWindow(void) {
    NSWindow *window = [[[NSWindow alloc] initWithContentRect:NSMakeRect(140, 140, 480, 240)
        styleMask:NSWindowStyleMaskTitled | NSWindowStyleMaskClosable | NSWindowStyleMaskMiniaturizable
            | NSWindowStyleMaskResizable | NSWindowStyleMaskFullSizeContentView
        backing:NSBackingStoreBuffered defer:NO] autorelease];
    [window setReleasedWhenClosed:NO];
    window.animationBehavior = NSWindowAnimationBehaviorNone;
    window.titlebarAppearsTransparent = YES;
    window.titleVisibility = NSWindowTitleHidden;
    NSView *content = [[[NSView alloc] initWithFrame:NSMakeRect(0, 0, 480, 240)] autorelease];
    content.wantsLayer = YES;
    content.layer.backgroundColor = [NSColor colorWithSRGBRed:30.0/255 green:60.0/255 blue:200.0/255 alpha:1].CGColor;
    window.contentView = content;
    return window;
}

static bool setHeight(NSWindow *window, double height) {
    char *failure = NULL;
    bool set = windowSetTitlebarHeight(window, height, &failure);
    if (!set) fprintf(stderr, "windowSetTitlebarHeight(%.1f): %s\n", height, failure);
    free(failure);
    return set;
}

// Model values: the center of the button area of windowControls (pt from the content top), and the model frame and
// presentationLayer frame of the close button layer.
static NSString *modelValues(NSWindow *window) {
    double area[4] = {0, 0, 0, 0};
    windowControls(window, area);
    NSButton *close = [window standardWindowButton:NSWindowCloseButton];
    CALayer *layer = close.layer;
    NSString *layers = @"no layer";
    if (layer) {
        CALayer *shown = layer.presentationLayer;
        layers = [NSString stringWithFormat:@"layer %@, presentation %@", NSStringFromRect(NSRectFromCGRect(layer.frame)),
            shown ? NSStringFromRect(NSRectFromCGRect(shown.frame)) : @"none"];
    }
    return [NSString stringWithFormat:@"title bar %.1f, buttons centre %.2f, close frame %@, %@",
        windowTitlebarHeight(window), area[1] + area[3] / 2, NSStringFromRect(close.frame), layers];
}

static double buttonsCentre(NSWindow *window) {
    double area[4] = {0, 0, 0, 0};
    windowControls(window, area);
    return area[1] + area[3] / 2;
}

// Measures the center (pt from the window top) of the rows that the window buttons occupy in one recording frame. It
// is the center of the first row and the last row that have pixels different from the content color. It skips the top
// left 6pt to avoid the window border and rounded corner. NAN if there is no button.
static double measuredCentre(NSData *data, double *displayed) {
    uint32_t head[3] = {0}; double info[7] = {0};
    if (data.length < sizeof(head) + sizeof(info)) return NAN;
    [data getBytes:head length:sizeof(head)];
    [data getBytes:info range:NSMakeRange(sizeof(head), sizeof(info))];
    if (!(head[0] > 0 && head[1] > 0 && head[2] >= head[0] * 4 &&
          data.length == sizeof(head) + sizeof(info) + (size_t)head[2] * head[1] && info[4] > 0 && info[5] > 0))
        return NAN;
    *displayed = info[6];
    const uint8_t *pixels = (const uint8_t *)data.bytes + sizeof(head) + sizeof(info);
    double scale = info[4] * info[5];
    // The content color is read at a place without buttons (100pt from the window top, 300pt from the left).
    size_t bx = (size_t)floor((info[0] + 300) * scale), by = (size_t)floor((info[1] + 100) * scale);
    if (bx >= head[0] || by >= head[1]) return NAN;
    const uint8_t *background = pixels + by * head[2] + bx * 4;
    long top = (long)floor(info[1] * scale);
    long first = -1, last = -1;
    for (long y = (long)floor((info[1] + 6) * scale); y < (long)floor((info[1] + 120) * scale) && y < (long)head[1]; y++) {
        for (long x = (long)floor((info[0] + 6) * scale); x < (long)floor((info[0] + 90) * scale) && x < (long)head[0]; x++) {
            const uint8_t *p = pixels + (size_t)y * head[2] + (size_t)x * 4;
            if (abs((int)p[0] - background[0]) > 40 || abs((int)p[1] - background[1]) > 40 ||
                abs((int)p[2] - background[2]) > 40) {
                if (first < 0) first = y;
                last = y;
                break;
            }
        }
    }
    if (first < 0) return NAN;
    return ((first - top) + (last - top) + 1) / 2.0 / scale;
}

// The changed title bar height (height), the time of the change (set) and the commit time (committed), and the button
// center before and after the change (from, to).
typedef struct { double height; double set; double committed; double from; double to; } SPChange;

// Opens a transaction, changes the title bar to to, does not commit during kRefreshes display refreshes, and commits
// afterwards.
static SPChange change(NSWindow *window, uint64_t ticket, double to) {
    SPChange result = { to, 0, 0, buttonsCentre(window), 0 };
    __block BOOL allowed = NO;
    surfaceLayoutBegin(window, ticket, ^(int ready) { allowed = ready; });
    check(allowed, [NSString stringWithFormat:@"the layout transaction %llu starts", ticket]);
    fprintf(stdout, "model before %.1fpt: %s\n", to, modelValues(window).UTF8String);
    result.set = CACurrentMediaTime() * 1000;
    check(setHeight(window, to), [NSString stringWithFormat:@"the title bar takes %.1fpt inside the open transaction", to]);
    result.to = buttonsCentre(window);
    fprintf(stdout, "model after setting %.1fpt in the open transaction: %s\n", to, modelValues(window).UTF8String);
    double waited = waitFrames(window.screen, kRefreshes);
    fprintf(stdout, "model after %d refreshes (%.1fms) in the open transaction: %s\n",
        kRefreshes, waited, modelValues(window).UTF8String);
    result.committed = CACurrentMediaTime() * 1000;
    check(surfaceLayoutCommit(window, ticket), [NSString stringWithFormat:@"the layout transaction %llu commits", ticket]);
    waited = waitFrames(window.screen, kRefreshes);
    fprintf(stdout, "model after %d refreshes (%.1fms) after the commit: %s\n",
        kRefreshes, waited, modelValues(window).UTF8String);
    return result;
}

// Judges the recording frames at every change, in display time order. Every frame displayed after the title bar
// change and before the commit has the previous position, the last frame after the commit and before the next change
// has the new position, and the position does not return to the previous one after the new one appears.
static void judge(NSString *directory, int count, const SPChange *changes, int total) {
    double centres[count], shown[count];
    for (int index = 0; index < count; index++) {
        NSString *path = [directory stringByAppendingPathComponent:
            [NSString stringWithFormat:@"frame-%04d.bgra", index + 1]];
        NSData *data = readCaptureFrame([NSData dataWithContentsOfFile:path]);
        shown[index] = NAN;
        centres[index] = data ? measuredCentre(data, &shown[index]) : NAN;
        check(!isnan(centres[index]) && !isnan(shown[index]), [NSString stringWithFormat:
            @"frame %d/%d shows the window buttons (centre %.2fpt, display %.3f)", index + 1, count, centres[index], shown[index]]);
    }
    for (int c = 0; c < total; c++) {
        const SPChange *at = &changes[c];
        double next = c + 1 < total ? changes[c + 1].set : INFINITY;
        int held = 0, after = 0, lastAfter = -1;
        BOOL moved = NO, returned = NO;
        double firstNew = NAN;
        for (int index = 0; index < count; index++) {
            if (isnan(centres[index])) continue;
            BOOL old = fabs(centres[index] - at->from) <= 0.5;
            BOOL new = fabs(centres[index] - at->to) <= 0.5;
            if (shown[index] >= at->set && shown[index] < at->committed) {
                held++;
                check(old, [NSString stringWithFormat:@"%.1fpt title bar: frame %d displayed %.1fms after the change and "
                    "%.1fms before the commit keeps the buttons at %.2fpt (measured %.2fpt)",
                    at->height, index + 1, shown[index] - at->set, at->committed - shown[index], at->from, centres[index]]);
            } else if (shown[index] >= at->committed && shown[index] < next) {
                after++;
                lastAfter = index;
                check(old || new, [NSString stringWithFormat:@"%.1fpt title bar: frame %d after the commit shows the buttons at "
                    "%.2fpt or %.2fpt (measured %.2fpt)", at->height, index + 1, at->from, at->to, centres[index]]);
                if (new && !moved) firstNew = shown[index] - at->committed;
                if (new) moved = YES;
                else if (moved) returned = YES;
            }
        }
        fprintf(stdout, "%.1fpt title bar: %d frames between the change and the commit, %d frames after the commit, "
            "first new frame %.1fms after the commit\n", at->height, held, after, firstNew);
        // If there is no frame before the commit, it is not an observation that the change did not appear on screen.
        check(held > 0, [NSString stringWithFormat:@"%.1fpt title bar: the recording has frames displayed while the "
            "transaction is open (%d)", at->height, held]);
        check(lastAfter >= 0 && fabs(centres[lastAfter] - at->to) <= 0.5 && !returned, [NSString stringWithFormat:
            @"%.1fpt title bar: the buttons reach %.2fpt after the commit and stay (last frame %.2fpt)",
            at->height, at->to, lastAfter >= 0 ? centres[lastAfter] : NAN]);
    }
}

int main(void) { @autoreleasepool {
    atexit(cleanupRecording);
    [NSApplication sharedApplication];
    [NSApp setActivationPolicy:NSApplicationActivationPolicyProhibited];
    [NSApp finishLaunching];
    [NSApp setActivationPolicy:NSApplicationActivationPolicyAccessory];

    NSWindow *window = hostLikeWindow();
    check(setHeight(window, 40), @"the window starts with a 40pt title bar");
    [window orderFrontRegardless];
    waitFrames(window.screen, kRefreshes);

    char directory[] = "/tmp/soksak-titlebar-test-XXXXXX";
    BOOL created = mkdtemp(directory) != NULL;
    check(created, @"the title bar recording directory is created");
    if (!created) { [window close]; return 1; }
    recordingDirectory = [[NSString stringWithUTF8String:directory] copy];
    char *operationError = NULL;
    BOOL opened = sp_capture_open(window.windowNumber, false, &operationError);
    BOOL started = NO;
    if (opened) { free(operationError); operationError = NULL; started = sp_capture_start(directory, &operationError); }
    check(started, [NSString stringWithFormat:@"the title bar recording starts (%s)", operationError == NULL ? "" : operationError]);
    free(operationError);
    if (started) {
        check(sp_capture_wait() > 0, @"the title bar recording contains its initial frame");
        // The heights are the first rows for frame font scales 1 and 2. Raises then lowers.
        SPChange changes[2];
        changes[0] = change(window, 201, 80);
        changes[1] = change(window, 202, 40);
        int count = sp_capture_stop(CACurrentMediaTime() * 1000);
        const char *recordingError = sp_capture_error();
        check(recordingError[0] == 0 && !sp_capture_limited(), [NSString stringWithFormat:
            @"the title bar recording ends without error or truncation (%s)", recordingError[0] ? recordingError : "none"]);
        check(count >= 3, [NSString stringWithFormat:@"the title bar recording has frames for both changes (%d)", count]);
        fprintf(stdout, "recording: %d frames, longest gap %.1fms\n", count, sp_capture_longest_gap());
        judge(recordingDirectory, count, changes, 2);
    }
    cleanupRecording();
    [window close];
    return failures ? 1 : 0;
}}
