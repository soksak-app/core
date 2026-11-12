// A window behind another window, with a web view registered as a host registers it and a child window, as a modal stands over
// it, is captured: the still is written at the device-pixel size of the window, and the capture does not change the window. A
// recording of the covered window takes a still every refresh for three seconds: every planned still is written, names the child
// window and then the window, and has a frame file of the declared format. The pixels are evidence and are not judged
// (docs/spec/diagnostics.md). The check uses no activation, no real input and no window position outside the screen.
// The capture asks the window server for the windows of its own process; the check prints whether the process has the screen
// recording permission.
#import <Cocoa/Cocoa.h>
#import <QuartzCore/QuartzCore.h>
#import <WebKit/WebKit.h>
#import "capture.h"
#import "window_facts.h"
#import "private/webkit.h"
#import "support/run_until.h"
#import "support/temporary_folder.h"
#import "support/capture_frame.m"

@interface WKWebView (Presentation)
- (void)_doAfterNextPresentationUpdate:(void (^)(void))update;
@end

static int failures;
static const CGFloat kWidth = 480, kHeight = 320;

static void check(BOOL condition, NSString *message) {
    fprintf(stderr, "%s: %s\n", condition ? "PASS" : "FAIL", message.UTF8String);
    if (!condition) failures++;
}
// Runs the run loop until done holds (support/run_until.h).
static void until(NSString *what, BOOL (^done)(void)) {
    sp_run_until(what.UTF8String, done);
}
static void waitForPresentation(WKWebView *web) {
    __block BOOL presented = NO;
    [web _doAfterNextPresentationUpdate:^{ presented = YES; }];
    until(@"the web view presents", ^BOOL { return presented; });
}
static id evaluate(WKWebView *web, NSString *script) {
    __block BOOL done = NO;
    __block NSString *failure = nil;
    __block id value = nil;
    [web evaluateJavaScript:script completionHandler:^(id result, NSError *error) {
        failure = [error.localizedDescription copy];
        value = [result retain];
        done = YES;
    }];
    until(@"the page script answers", ^BOOL { return done; });
    check(failure == nil, [NSString stringWithFormat:@"the page script runs (%@)", failure ?: @""]);
    [failure release];
    return [value autorelease];
}
// A still capture of the window into name.png in directory: whether it is written and its pixel size. The content of the pixels is
// not judged; the capture is evidence that a failing check keeps.
static CGSize capture(NSWindow *window, NSString *directory, NSString *name) {
    NSString *path = [directory stringByAppendingPathComponent:[name stringByAppendingString:@".png"]];
    char *error = NULL;
    // The capture finds the child windows of the window itself.
    bool written = sp_capture_still(window.windowNumber, path.fileSystemRepresentation, &error);
    check(written && error == NULL, [NSString stringWithFormat:@"the %@ capture has no error (%s)", name, error ?: ""]);
    free(error);
    if (!written) return CGSizeZero;
    CGImageSourceRef source = CGImageSourceCreateWithData((CFDataRef)[NSData dataWithContentsOfFile:path], NULL);
    CGImageRef decoded = source ? CGImageSourceCreateImageAtIndex(source, 0, NULL) : NULL;
    CGSize size = decoded ? CGSizeMake(CGImageGetWidth(decoded), CGImageGetHeight(decoded)) : CGSizeZero;
    if (decoded) CGImageRelease(decoded);
    if (source) CFRelease(source);
    return size;
}

// Counts the refreshes of the display of the window and keeps their times.
@interface Refreshes : NSObject
@property (nonatomic, retain) NSMutableArray<NSNumber *> *times;
@end
@implementation Refreshes
- (void)refresh:(CADisplayLink *)link { [self.times addObject:@(link.timestamp * 1000)]; }
@end

static double median(NSArray<NSNumber *> *values) {
    NSArray<NSNumber *> *sorted = [values sortedArrayUsingSelector:@selector(compare:)];
    return sorted.count == 0 ? 0 : sorted[sorted.count / 2].doubleValue;
}
static double ticksToMilliseconds(id value, double numerator, double denominator) {
    return [value isKindOfClass:NSString.class] ? strtoull([value UTF8String], NULL, 10) * numerator / denominator / 1e6 : NAN;
}

int main(void) { @autoreleasepool {
    fprintf(stderr, "START: covered window capture\n");
    [NSApplication sharedApplication];
    [NSApp setActivationPolicy:NSApplicationActivationPolicyProhibited];
    [NSApp finishLaunching];
    BOOL permitted = CGPreflightScreenCaptureAccess();
    fprintf(stderr, "screen recording permission: %s\n", permitted ? "granted" : "not granted");
    NSString *directory = temporaryFolder(@"soksak-capture-covered-");

    NSWindow *window = [[NSWindow alloc] initWithContentRect:NSMakeRect(160, 160, kWidth, kHeight)
        styleMask:NSWindowStyleMaskTitled backing:NSBackingStoreBuffered defer:NO];
    window.releasedWhenClosed = NO;
    window.animationBehavior = NSWindowAnimationBehaviorNone;
    // The layout passes of the window, which a capture must not cause. AppKit posts NSWindowDidLayoutNotification after each
    // layout pass of a window; the SDK declares no constant for it, so the check names it.
    __block NSUInteger layouts = 0;
    id layoutObserver = [NSNotificationCenter.defaultCenter addObserverForName:@"NSWindowDidLayoutNotification" object:window queue:nil
        usingBlock:^(NSNotification *note) { (void)note; layouts++; }];
    NSString *(^windowState)(void) = ^NSString * {
        return [NSString stringWithFormat:@"buttons close %d miniaturize %d zoom %d, layouts %lu",
            [window standardWindowButton:NSWindowCloseButton] != nil, [window standardWindowButton:NSWindowMiniaturizeButton] != nil,
            [window standardWindowButton:NSWindowZoomButton] != nil, (unsigned long)layouts];
    };
    NSView *content = window.contentView;
    content.wantsLayer = YES;
    WKWebView *web = [[WKWebView alloc] initWithFrame:content.bounds configuration:[[WKWebViewConfiguration new] autorelease]];
    [content addSubview:web];
    [window orderBack:nil];
    check(sp_window_set_main_webview(window, web) != NULL, @"the web view is registered as a host registers it");
    [web loadHTMLString:@"<!doctype html><style>html,body{margin:0}</style><p>covered</p>" baseURL:nil];
    until(@"the page load ends", ^BOOL { return !web.isLoading; });
    check(!web.isLoading, @"the page loads behind other windows");
    CGFloat scale = window.backingScaleFactor;
    CGSize windowPixels = CGSizeMake(window.frame.size.width * scale, window.frame.size.height * scale);
    // A child window stands over the window, as a modal does.
    NSWindow *child = [[NSWindow alloc] initWithContentRect:[window convertRectToScreen:
        [content convertRect:NSMakeRect(150, kHeight - 310, 60, 60) toView:nil]]
        styleMask:NSWindowStyleMaskBorderless backing:NSBackingStoreBuffered defer:NO];
    child.releasedWhenClosed = NO;
    child.animationBehavior = NSWindowAnimationBehaviorNone;
    [window addChildWindow:child ordered:NSWindowAbove];
    [child displayIfNeeded];
    [CATransaction flush];
    waitForPresentation(web);

    // A capture does not change the window: its title bar buttons and its layout passes are the same before the first capture
    // and after the covered capture.
    NSWindow *cover = [[NSWindow alloc] initWithContentRect:NSMakeRect(100, 100, kWidth + 160, kHeight + 160)
        styleMask:NSWindowStyleMaskBorderless backing:NSBackingStoreBuffered defer:NO];
    cover.releasedWhenClosed = NO;
    cover.animationBehavior = NSWindowAnimationBehaviorNone;
    NSString *beforeCaptures = windowState();
    CGSize before = capture(window, directory, @"before");
    check(CGSizeEqualToSize(before, windowPixels), [NSString stringWithFormat:@"the capture before the cover has the device-pixel "
        "size of the window (%.0fx%.0f, window %.0fx%.0f)", before.width, before.height, windowPixels.width, windowPixels.height]);

    [cover orderWindow:NSWindowAbove relativeTo:window.windowNumber];
    // AppKit keeps the order in the open Core Animation transaction of the thread until the run loop commits it, so the window
    // server lists the cover only after this commit.
    [CATransaction flush];
    // A window behind other windows is occluded already, so the place of the cover in the window list says that it covers.
    __block NSInteger targetIndex = -1, childIndex = -1, coverIndex = -1;
    BOOL (^coverIsOver)(void) = ^BOOL {
        NSArray *stack = [(NSArray *)CGWindowListCopyWindowInfo(kCGWindowListOptionOnScreenOnly, kCGNullWindowID) autorelease];
        targetIndex = childIndex = coverIndex = -1;
        NSInteger index = 0;
        for (NSDictionary *entry in stack) {
            if ([entry[(id)kCGWindowNumber] longValue] == window.windowNumber) targetIndex = index;
            if ([entry[(id)kCGWindowNumber] longValue] == child.windowNumber) childIndex = index;
            if ([entry[(id)kCGWindowNumber] longValue] == cover.windowNumber) coverIndex = index;
            index++;
        }
        return coverIndex >= 0 && targetIndex > coverIndex && childIndex > coverIndex;
    };
    // The commit of the order returns after the window server has placed the cover.
    BOOL coverOver = coverIsOver();
    check(coverOver && NSContainsRect(cover.frame, window.frame) && NSContainsRect(cover.frame, child.frame),
        [NSString stringWithFormat:@"the cover is over the whole window and its child (cover %ld, window %ld, child %ld)",
            (long)coverIndex, (long)targetIndex, (long)childIndex]);
    check((window.occlusionState & NSWindowOcclusionStateVisible) == 0, @"the window server reports the window as occluded");
    // WebKit hides the document of an occluded window after a delay, only while it detects the occlusion of the window. The
    // registered web view does not detect it, so its document stays shown.
    check(!web._windowOcclusionDetectionEnabled, @"the registered web view does not detect the occlusion of its window");
    check([evaluate(web, @"document.visibilityState") isEqual:@"visible"], @"the document of the covered window stays visible");

    CGSize covered = capture(window, directory, @"covered");
    check(CGSizeEqualToSize(covered, windowPixels), [NSString stringWithFormat:@"the capture of the covered window has the "
        "device-pixel size of the window (%.0fx%.0f)", covered.width, covered.height]);
    NSString *afterCovered = windowState();
    check([afterCovered isEqual:beforeCaptures], [NSString stringWithFormat:
        @"the capture does not change the window: the same buttons and layouts after the covered capture (before %@, after %@)",
        beforeCaptures, afterCovered]);

    // A recording of the covered window: a still every refresh for three seconds.
    Refreshes *refreshes = [[Refreshes new] autorelease];
    refreshes.times = [NSMutableArray array];
    CADisplayLink *link = [window displayLinkWithTarget:refreshes selector:@selector(refresh:)];
    [link addToRunLoop:NSRunLoop.mainRunLoop forMode:NSRunLoopCommonModes];
    // The refresh period of the display of the window, as the window observes it, is the gap of the recording.
    until(@"the window observes 13 refreshes", ^BOOL { return refreshes.times.count >= 13; });
    [link invalidate];
    NSMutableArray<NSNumber *> *periods = [NSMutableArray array];
    for (NSUInteger index = 1; index < refreshes.times.count; index++)
        [periods addObject:@(refreshes.times[index].doubleValue - refreshes.times[index - 1].doubleValue)];
    double period = median(periods);
    fprintf(stderr, "refresh period %.3f ms\n", period);
    NSString *recorded = [directory stringByAppendingPathComponent:@"recording"];
    [NSFileManager.defaultManager createDirectoryAtPath:recorded withIntermediateDirectories:NO attributes:nil error:NULL];
    char *error = NULL;
    check(sp_capture_open(window.windowNumber, false, &error), [NSString stringWithFormat:@"the covered window opens for a recording (%s)", error ?: ""]);
    free(error); error = NULL;
    double length = 3000;
    bool started = sp_capture_start(recorded.fileSystemRepresentation, period, length / 1000, 0, false, 1, &error);
    check(started, [NSString stringWithFormat:@"the recording of the covered window starts (%s)", error ?: ""]);
    free(error); error = NULL;
    NSUInteger planned = (NSUInteger)ceil(length / period);
    // The start returns once still 0 is written, and the header of its frame holds its request time, at which the plan starts.
    // The last still is planned at that time plus (planned - 1) gaps, and a still is requested at or after its planned time, so
    // the stop waits for the completion of the last still. The stop waits on another thread while the main thread runs.
    NSData *firstFrame = readCaptureFrame([NSData dataWithContentsOfFile:[recorded stringByAppendingPathComponent:@"frame-0000.bgra"]]);
    double firstRequest = NAN;
    if (firstFrame != nil) memcpy(&firstRequest, (const uint8_t *)firstFrame.bytes + 12 + 6 * sizeof(double), sizeof firstRequest);
    check(!started || isfinite(firstRequest), @"the frame of still 0 holds its request time");
    double after = firstRequest + (planned - 1) * period;
    __block int count = 0;
    __block BOOL stopReturned = NO;
    if (started && isfinite(firstRequest)) {
        dispatch_async(dispatch_get_global_queue(QOS_CLASS_USER_INITIATED, 0), ^{
            int stoppedCount = sp_capture_stop(after, 2);
            dispatch_async(dispatch_get_main_queue(), ^{ count = stoppedCount; stopReturned = YES; });
        });
        until(@"the stop returns after the completion of the last planned still", ^BOOL { return stopReturned; });
    } else if (started) {
        count = sp_capture_stop(0, 2);
    }
    const char *stopped = sp_capture_error();
    check(started && stopped != NULL && strlen(stopped) == 0, [NSString stringWithFormat:@"the recording stops without error (%s)", stopped ?: ""]);
    check(count == (int)planned && sp_capture_missed() == 0 && sp_capture_late() == 0,
        [NSString stringWithFormat:@"the covered window gives every planned still: %lu planned, %d written, %d missed, %d late",
            (unsigned long)planned, count, sp_capture_missed(), sp_capture_late()]);

    NSString *rowsText = [NSString stringWithContentsOfFile:[recorded stringByAppendingPathComponent:@"stills.jsonl"]
        encoding:NSUTF8StringEncoding error:NULL];
    NSMutableArray<NSDictionary *> *rows = [NSMutableArray array];
    for (NSString *line in [rowsText componentsSeparatedByString:@"\n"]) {
        if (line.length == 0) continue;
        NSDictionary *row = [NSJSONSerialization JSONObjectWithData:[line dataUsingEncoding:NSUTF8StringEncoding] options:0 error:NULL];
        if ([row isKindOfClass:NSDictionary.class]) [rows addObject:row];
    }
    check(rows.count == planned, [NSString stringWithFormat:@"stills.jsonl holds a row for each planned still (%lu rows)", (unsigned long)rows.count]);
    // Each written still names the child window and then the window, and its frame file has the declared header, size and
    // checksum at the device-pixel size of the window. The pixels are evidence and are not judged.
    NSUInteger wrongWindows = 0, missing = 0, wrongSize = 0, longGaps = 0;
    double previousRequest = NAN, longestRequestGap = 0;
    for (NSDictionary *row in rows) {
        double numerator = [row[@"machTimebaseNumerator"] doubleValue], denominator = [row[@"machTimebaseDenominator"] doubleValue];
        double requested = ticksToMilliseconds(row[@"requested"], numerator, denominator);
        NSArray *windows = row[@"windows"];
        if (![windows isKindOfClass:NSArray.class] || windows.count != 2 || [windows[0] longValue] != child.windowNumber
            || [windows[1] longValue] != window.windowNumber) wrongWindows++;
        if (!isnan(previousRequest) && requested - previousRequest > 2 * period) longGaps++;
        if (!isnan(previousRequest)) longestRequestGap = MAX(longestRequestGap, requested - previousRequest);
        previousRequest = requested;
        NSData *frame = [row[@"frame"] isKindOfClass:NSString.class]
            ? readCaptureFrame([NSData dataWithContentsOfFile:[recorded stringByAppendingPathComponent:row[@"frame"]]]) : nil;
        if (frame == nil) { missing++; continue; }
        uint32_t dimensions[3];
        memcpy(dimensions, frame.bytes, sizeof dimensions);
        if (dimensions[0] != (uint32_t)windowPixels.width || dimensions[1] != (uint32_t)windowPixels.height) wrongSize++;
    }
    check(missing == 0, [NSString stringWithFormat:@"every row names a frame that reads (%lu do not)", (unsigned long)missing]);
    check(wrongSize == 0, [NSString stringWithFormat:@"every frame has the device-pixel size of the window (%lu do not)", (unsigned long)wrongSize]);
    check(wrongWindows == 0, [NSString stringWithFormat:@"every still holds the child window, then the window (%lu do not)", (unsigned long)wrongWindows]);
    check(longGaps == 0, [NSString stringWithFormat:@"no two stills are requested more than two refresh periods apart (%lu are; longest %.2f ms)",
        (unsigned long)longGaps, longestRequestGap]);

    check(!NSApp.isActive, @"the capture does not activate the application");
    // Which other application is in front belongs to the other processes, so the check judges only this process.
    check(NSWorkspace.sharedWorkspace.frontmostApplication.processIdentifier != getpid()
        && !NSRunningApplication.currentApplication.isActive, @"the capture does not bring the application to the front");
    [cover close];
    [window removeChildWindow:child];
    [child close];
    [NSNotificationCenter.defaultCenter removeObserver:layoutObserver];
    [window close];
    // The captures and the recording of a failed run are its evidence.
    if (failures) keepTemporaryFolder(directory);
    if (failures == 0) fprintf(stderr, "PASS: covered window capture\n");
    return failures == 0 ? 0 : 1;
} }
