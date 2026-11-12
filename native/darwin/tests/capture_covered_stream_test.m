// A recording of a window that another application's window covers completely delivers its changes as a recording of a shown
// window does. The window of a person (support/person_window.h) covers the recorded window, which changes at each display refresh
// of its display link: in the first case a plain Core Animation layer that the check commits itself, in the second a web view
// whose page changes at each animation frame. Each change writes its number in eight black or white stripes. While the window
// changes, still captures of the window follow one another (each starts when the one before it ends), so each still shows which
// change the window server holds at that time. The check judges, for the covered stretch of each case:
//   - the gaps: two frames of the recording that follow each other are at most 100 ms apart, as the window checks require;
//   - the lag: a change that a still showed reaches a frame of the recording at most 100 ms after that still ended;
//   - the last change reaches the recording;
//   - for the layer, each still shows at least the change that the check committed before it asked for the still.
// After the covered stretch the cover closes and the same changes run once more as a control; when the window of the check is
// covered by other windows at a refresh of that stretch, the control is not judged and the check says so.
// A third case opens a window behind the cover from the hold of a new window (sp_capture_hold_new_window), as a host opens a
// window for diagnostics.capture.start with newWindow, and judges that the first frame of its recording comes at most 100 ms after
// a still showed the window.
// No wait of the check ends by a time: a wait for the recording ends with its frame, or, once a still has shown the change that
// it waits for and the display link of the window has run 100 ms past that still without a new frame of the recording, the check
// ends it (sp_capture_end_wait) and names that.
// The check uses no activation, no real input and no window position outside the screen. It runs in the native end-to-end target
// test-app, because it needs the frames of ScreenCaptureKit.
#import <Cocoa/Cocoa.h>
#import <QuartzCore/QuartzCore.h>
#import <WebKit/WebKit.h>
#import <stdatomic.h>
#import "capture.h"
#import "window_facts.h"
#import "window_reveal.h"
#import "support/capture_frame.m"
#import "support/event_wait.h"
#import "support/person_window.h"
#import "support/temporary_folder.h"

static int failures;
static const CGFloat kWidth = 480, kHeight = 320;
static const int kChanges = 360, kControlChanges = 120;
static const double kLimitMs = 100;

static void check(BOOL condition, NSString *message) {
    fprintf(condition ? stdout : stderr, "%s: %s\n", condition ? "PASS" : "FAIL", message.UTF8String);
    if (!condition) failures++;
}

static void diagnostic(NSString *message) {
    fprintf(stderr, "DIAGNOSTIC: %s\n", message.UTF8String);
}

static _Atomic uint64_t lastToken;
static uint64_t nextToken(void) { return atomic_fetch_add(&lastToken, 1) + 1; }

#pragma mark - The number of a change in eight stripes

// The stripes stand in the top band of the window, 40 points wide each; stripe i is white when bit i of the number is set.
static NSRect stripeRect(int index) { return NSMakeRect(index * 40, kHeight - 60, 40, 60); }

// Reads the eight stripes from BGRA pixels of a window of width points; -1 when a stripe is neither black nor white.
static int stripesOf(const uint8_t *pixels, size_t width, size_t height, size_t stride) {
    double scale = width / kWidth;
    int number = 0;
    for (int index = 0; index < 8; index++) {
        size_t x = (size_t)((index * 40 + 20) * scale), y = (size_t)(30 * scale);
        if (x >= width || y >= height) return -1;
        const uint8_t *pixel = pixels + y * stride + x * 4;
        int level = (pixel[0] + pixel[1] + pixel[2]) / 3;
        if (level > 200) number |= 1 << index;
        else if (level > 55) return -1;
    }
    return number;
}

// The full number of a change from its low eight bits, the change being at most 127 changes before or after near.
static long unwrap(int low, long near) {
    long candidate = (near & ~0xffL) | low;
    if (candidate < near - 128) candidate += 256;
    if (candidate > near + 128) candidate -= 256;
    return candidate;
}

#pragma mark - Frames and stills

typedef struct { double shown; int low; } Frame;

// The frames of the recording in folder in their order: their display time (ms) and the number of their stripes.
static NSArray<NSValue *> *readFrames(NSString *folder) {
    NSMutableArray<NSValue *> *frames = [NSMutableArray array];
    NSArray *names = [[NSFileManager.defaultManager contentsOfDirectoryAtPath:folder error:NULL]
        sortedArrayUsingSelector:@selector(compare:)];
    for (NSString *name in names) {
        if (![name hasPrefix:@"frame-"] || ![name hasSuffix:@".bgra"]) continue;
        NSData *data = readCaptureFrame([NSData dataWithContentsOfFile:[folder stringByAppendingPathComponent:name]]);
        if (!data) continue;
        const uint8_t *bytes = data.bytes;
        uint32_t dimensions[3];
        memcpy(dimensions, bytes, sizeof dimensions);
        double shown;
        memcpy(&shown, bytes + 60, sizeof shown);
        Frame frame = { shown, stripesOf(bytes + 68, dimensions[0], dimensions[1], dimensions[2]) };
        [frames addObject:[NSValue valueWithBytes:&frame objCType:@encode(Frame)]];
    }
    return frames;
}

static NSUInteger frameFiles(NSString *folder) {
    NSUInteger count = 0;
    for (NSString *name in [NSFileManager.defaultManager contentsOfDirectoryAtPath:folder error:NULL])
        if ([name hasPrefix:@"frame-"]) count++;
    return count;
}

// The number of the stripes of a PNG still, or -1.
static int stillNumber(NSString *path) {
    CGImageSourceRef source = CGImageSourceCreateWithURL((CFURLRef)[NSURL fileURLWithPath:path], NULL);
    if (!source) return -1;
    CGImageRef image = CGImageSourceCreateImageAtIndex(source, 0, NULL);
    CFRelease(source);
    if (!image) return -1;
    size_t width = CGImageGetWidth(image), height = CGImageGetHeight(image);
    uint8_t *pixels = calloc(width * height, 4);
    CGColorSpaceRef srgb = CGColorSpaceCreateWithName(kCGColorSpaceSRGB);
    CGContextRef context = CGBitmapContextCreate(pixels, width, height, 8, width * 4, srgb,
        kCGImageAlphaPremultipliedFirst | kCGBitmapByteOrder32Little);
    CGColorSpaceRelease(srgb);
    CGContextDrawImage(context, CGRectMake(0, 0, width, height), image);
    CGContextRelease(context);
    CGImageRelease(image);
    int number = stripesOf(pixels, width, height, width * 4);
    free(pixels);
    return number;
}

// The stills of one stretch: each requested at `asked` (ms), ended at `ended` (ms), showing `low`, after the check had committed
// change `committed` (the layer case; -1 otherwise).
typedef struct { double asked, ended; int low; long committed; } Still;

@interface SPStretch : NSObject
@property (nonatomic, retain) NSString *folder;
@property (nonatomic) long window;
@property (atomic) BOOL running;
@property (atomic) long committed;
@property (nonatomic, retain) NSMutableArray<NSValue *> *stills;
@property (nonatomic, assign) dispatch_queue_t queue;
@end

@implementation SPStretch
- (void)dealloc { [_folder release]; [_stills release]; if (_queue) dispatch_release(_queue); [super dealloc]; }

// Takes stills of the window one after another until running ends; each ends before the next starts.
- (void)startStills {
    self.stills = [NSMutableArray array];
    self.queue = dispatch_queue_create("capture_covered_stream.stills", DISPATCH_QUEUE_SERIAL);
    self.running = YES;
    [self nextStill];
}

- (void)nextStill {
    dispatch_async(self.queue, ^{
        if (!self.running) return;
        NSString *path = [self.folder stringByAppendingPathComponent:
            [NSString stringWithFormat:@"still-%04lu.png", (unsigned long)self.stills.count]];
        long committed = self.committed;
        double asked = sp_capture_clock();
        char *error = NULL;
        long numbers[1] = { self.window };
        bool written = sp_capture_still(numbers, 1, path.fileSystemRepresentation, nextToken(), &error);
        double ended = sp_capture_clock();
        if (!written) diagnostic([NSString stringWithFormat:@"a still failed: %s", error ?: "no error"]);
        free(error);
        Still still = { asked, ended, written ? stillNumber(path) : -1, committed };
        [[NSFileManager defaultManager] removeItemAtPath:path error:NULL];
        dispatch_async(dispatch_get_main_queue(), ^{
            [self.stills addObject:[NSValue valueWithBytes:&still objCType:@encode(Still)]];
            eventWake();
        });
        [self nextStill];
    });
}

- (void)stopStills {
    self.running = NO;
    dispatch_sync(self.queue, ^{});
}
@end

#pragma mark - A wait of the recording that a still can end

// The stills taken while the wait runs, and the frame files when the last of them showed what the wait waits for.
static Still lastStill(SPStretch *stretch) {
    Still still = { 0, 0, -1, -1 };
    if (stretch.stills.count) [stretch.stills.lastObject getValue:&still];
    return still;
}

@interface SPRefreshes : NSObject
@property (nonatomic, copy) void (^tick)(CADisplayLink *link);
@end
@implementation SPRefreshes
- (void)dealloc { [_tick release]; [super dealloc]; }
- (void)refresh:(CADisplayLink *)link { if (self.tick) self.tick(link); }
@end

// Runs call (a wait of the recording with token) off the main thread and waits for its answer. While it waits, at each display
// refresh of view: once a still ended showing what shown accepts, and the refreshes ran past 100 ms after that still without a new
// frame file, the wait is ended with reason. Returns the answer of call, and whether the check ended the wait.
static int awaitRecording(NSString *what, NSView *view, SPStretch *stretch, uint64_t token, BOOL (^shown)(Still still),
    NSString *reason, int (^call)(void), BOOL *ended) {
    __block int result = 0;
    __block BOOL answered = NO;
    __block BOOL endedByCheck = NO;
    __block double seenAt = 0;
    __block NSUInteger filesAtSeen = 0;
    dispatch_async(dispatch_get_global_queue(QOS_CLASS_USER_INITIATED, 0), ^{
        int value = call();
        dispatch_async(dispatch_get_main_queue(), ^{ result = value; answered = YES; eventWake(); });
    });
    SPRefreshes *refreshes = [[SPRefreshes new] autorelease];
    refreshes.tick = ^(CADisplayLink *link) {
        if (answered || endedByCheck) return;
        Still still = lastStill(stretch);
        if (seenAt == 0 && still.low >= 0 && shown(still)) { seenAt = still.ended; filesAtSeen = frameFiles(stretch.folder); }
        if (seenAt > 0 && sp_capture_clock() - seenAt > kLimitMs) {
            if (frameFiles(stretch.folder) > filesAtSeen) { seenAt = 0; return; }
            endedByCheck = YES;
            sp_capture_end_wait(token, reason.UTF8String);
        }
    };
    CADisplayLink *link = [view displayLinkWithTarget:refreshes selector:@selector(refresh:)];
    [link addToRunLoop:NSRunLoop.mainRunLoop forMode:NSRunLoopCommonModes];
    eventWait(what, ^BOOL { return answered; });
    [link invalidate];
    if (ended) *ended = endedByCheck;
    return result;
}

#pragma mark - The judgments of a stretch

static void judgeStretch(NSString *name, SPStretch *stretch, NSArray<NSValue *> *frames, double from, double to, long first,
    long last, BOOL layer, BOOL stopEnded) {
    // The frames of the stretch with their full numbers.
    NSMutableArray<NSArray *> *numbered = [NSMutableArray array];
    long near = first;
    for (NSValue *value in frames) {
        Frame frame;
        [value getValue:&frame];
        if (frame.shown < from || frame.low < 0) continue;
        long number = unwrap(frame.low, near);
        near = number;
        [numbered addObject:@[ @(frame.shown), @(number) ]];
    }
    // The gaps are measured from the first frame, so the start of the stream is not one of them; a stretch without a frame has
    // one gap, the whole stretch.
    double longest = numbered.count ? 0 : to - from, at = from;
    double previous = numbered.count ? [numbered.firstObject[0] doubleValue] : from;
    double started = previous;
    for (NSArray *frame in numbered) {
        double shown = [frame[0] doubleValue];
        if (shown > to) break;
        if (shown - previous > longest) { longest = shown - previous; at = previous; }
        previous = shown;
    }
    check(longest <= kLimitMs, [NSString stringWithFormat:@"%@: two frames of the recording follow each other within %.0f ms while "
        "the window changes at each refresh (%lu frames, longest gap %.1f ms after %.1f ms of the stretch)", name, kLimitMs,
        (unsigned long)numbered.count, longest, at - from]);

    NSUInteger late = 0, judged = 0;
    double worst = 0;
    long worstNumber = -1;
    NSUInteger behind = 0;
    long behindStill = -1, behindCommitted = -1;
    long nearStill = first;
    for (NSValue *value in stretch.stills) {
        Still still;
        [value getValue:&still];
        // A still that ended before the first frame of the stretch is not judged: the stream had not started.
        if (still.low < 0 || still.asked < from || (numbered.count && still.ended < started)) continue;
        long number = unwrap(still.low, nearStill);
        nearStill = number;
        if (layer && number < still.committed) { behind++; behindStill = number; behindCommitted = still.committed; }
        judged++;
        double reached = INFINITY;
        for (NSArray *frame in numbered) {
            if ([frame[1] longValue] >= number) { reached = [frame[0] doubleValue]; break; }
        }
        double lag = reached - still.ended;
        if (lag > kLimitMs) { late++; if (lag > worst) { worst = lag; worstNumber = number; } }
    }
    check(judged > 0 && late == 0, [NSString stringWithFormat:@"%@: each change that a still showed reaches the recording within "
        "%.0f ms after the still (%lu of %lu stills late, the latest change %ld after %@)", name, kLimitMs, (unsigned long)late,
        (unsigned long)judged, worstNumber, isinf(worst) ? @"never" : [NSString stringWithFormat:@"%.1f ms", worst]]);
    if (layer) {
        check(judged > 0 && behind == 0, [NSString stringWithFormat:@"%@: each still shows at least the change committed before it "
            "was asked for (%lu of %lu behind, the last showed %ld after %ld was committed)", name, (unsigned long)behind,
            (unsigned long)judged, behindStill, behindCommitted]);
    }
    long lastShown = numbered.count ? [numbered.lastObject[1] longValue] : -1;
    check(!stopEnded && lastShown >= last, [NSString stringWithFormat:@"%@: the last change %ld reaches the recording (the last "
        "frame shows %ld%@)", name, last, lastShown, stopEnded ? @"; the check ended the stop" : @""]);
}

#pragma mark - The cases

// Whether some part of window shows, as AppKit reports it.
static BOOL shows(NSWindow *window) { return (window.occlusionState & NSWindowOcclusionStateVisible) != 0; }

@interface SPLayerChanges : NSObject
@property (nonatomic, retain) NSArray<CALayer *> *stripes;
@property (nonatomic, retain) SPStretch *stretch;
@property (nonatomic) long next, until;
@property (nonatomic) double firstAt, lastAt;
@property (nonatomic) BOOL coveredAtSomeRefresh;
@property (nonatomic, assign) NSWindow *window;
@end
@implementation SPLayerChanges
- (void)dealloc { [_stripes release]; [_stretch release]; [super dealloc]; }
- (void)refresh:(CADisplayLink *)link {
    if (self.next > self.until) return;
    if (!shows(self.window)) self.coveredAtSomeRefresh = YES;
    long number = self.next++;
    [CATransaction begin];
    [CATransaction setDisableActions:YES];
    for (int index = 0; index < 8; index++) {
        self.stripes[index].backgroundColor = (number >> index) & 1 ? CGColorGetConstantColor(kCGColorWhite)
            : CGColorGetConstantColor(kCGColorBlack);
    }
    [CATransaction commit];
    [CATransaction flush];
    double now = sp_capture_clock();
    if (self.firstAt == 0) self.firstAt = now;
    self.lastAt = now;
    self.stretch.committed = number;
}
@end

static NSWindow *makeWindow(NSRect frame) {
    NSWindow *window = [[NSWindow alloc] initWithContentRect:frame styleMask:NSWindowStyleMaskBorderless
        backing:NSBackingStoreBuffered defer:NO];
    window.releasedWhenClosed = NO;
    window.animationBehavior = NSWindowAnimationBehaviorNone;
    window.backgroundColor = [NSColor colorWithSRGBRed:0.2 green:0.2 blue:0.25 alpha:1];
    window.contentView.wantsLayer = YES;
    return window;
}

// Records window while changes run from first to last, with stills; returns the stretch and whether the check ended the stop.
static SPStretch *recordStretch(NSString *name, NSWindow *window, NSString *folder, long first, long last,
    void (^begin)(SPStretch *stretch), BOOL (^done)(void), double *from, double *to, BOOL *stopEnded) {
    SPStretch *stretch = [[SPStretch new] autorelease];
    stretch.folder = folder;
    stretch.window = window.windowNumber;
    stretch.committed = first - 1;
    char *error = NULL;
    BOOL opened = sp_capture_open(window.windowNumber, false, nextToken(), &error);
    check(opened, [NSString stringWithFormat:@"%@: the recording opens the window (%s)", name, error ?: ""]);
    free(error); error = NULL;
    BOOL started = opened && sp_capture_start(folder.fileSystemRepresentation, false, &error);
    check(started, [NSString stringWithFormat:@"%@: the recording starts (%s)", name, error ?: ""]);
    free(error);
    if (!started) return nil;
    [stretch startStills];
    *from = sp_capture_clock();
    begin(stretch);
    eventWait([NSString stringWithFormat:@"%@: the changes from %ld to %ld end", name, first, last], done);
    *to = sp_capture_clock();
    uint64_t token = nextToken();
    double after = *to;
    BOOL ended = NO;
    int count = awaitRecording([NSString stringWithFormat:@"%@: the stop of the recording after the last change", name],
        window.contentView, stretch, token, ^BOOL(Still still) { return unwrap(still.low, last) >= last; },
        @"a still showed the last change and the display link ran 100 ms past it without a frame of the recording",
        ^int { return sp_capture_stop(after, token); }, &ended);
    [stretch stopStills];
    const char *stopError = sp_capture_error();
    diagnostic([NSString stringWithFormat:@"%@: the stop answered %d frames (%s)", name, count, stopError ?: "no error"]);
    *stopEnded = ended;
    return stretch;
}

static void runLayerCase(NSWindow *window, NSString *root, long cover) {
    NSView *content = window.contentView;
    NSMutableArray<CALayer *> *stripes = [NSMutableArray array];
    for (int index = 0; index < 8; index++) {
        CALayer *stripe = [CALayer layer];
        stripe.frame = stripeRect(index);
        stripe.backgroundColor = CGColorGetConstantColor(kCGColorBlack);
        [content.layer addSublayer:stripe];
        [stripes addObject:stripe];
    }
    [CATransaction flush];
    for (int pass = 0; pass < 2; pass++) {
        BOOL control = pass == 1;
        NSString *name = control ? @"layer, control" : @"layer, covered";
        if (control) {
            check(sp_person_close(cover), @"the cover of the person closes");
        }
        long first = control ? 1000 : 0, last = first + (control ? kControlChanges : kChanges) - 1;
        NSString *folder = [root stringByAppendingPathComponent:control ? @"layer-control" : @"layer-covered"];
        [NSFileManager.defaultManager createDirectoryAtPath:folder withIntermediateDirectories:NO attributes:nil error:NULL];
        SPLayerChanges *changes = [[SPLayerChanges new] autorelease];
        changes.stripes = stripes;
        changes.window = window;
        changes.next = first;
        changes.until = last;
        __block CADisplayLink *link = nil;
        double from = 0, to = 0;
        BOOL stopEnded = NO;
        SPStretch *stretch = recordStretch(name, window, folder, first, last, ^(SPStretch *running) {
            changes.stretch = running;
            link = [content displayLinkWithTarget:changes selector:@selector(refresh:)];
            [link addToRunLoop:NSRunLoop.mainRunLoop forMode:NSRunLoopCommonModes];
        }, ^BOOL { return changes.next > last; }, &from, &to, &stopEnded);
        [link invalidate];
        if (!stretch) continue;
        if (control && changes.coveredAtSomeRefresh) {
            diagnostic(@"layer, control: other windows covered the window of the check at a refresh, so the control is not judged");
            continue;
        }
        if (!control && changes.coveredAtSomeRefresh == NO) {
            diagnostic(@"layer, covered: AppKit reported a part of the window shown at every refresh");
        }
        judgeStretch(name, stretch, readFrames(folder), from, to, first, last, YES, stopEnded);
    }
}

@interface SPPageEnd : NSObject <WKScriptMessageHandler>
@property (nonatomic) BOOL ended;
@property (nonatomic) long number;
@end
@implementation SPPageEnd
- (void)userContentController:(WKUserContentController *)controller didReceiveScriptMessage:(WKScriptMessage *)message {
    if ([message.body isKindOfClass:NSNumber.class]) self.number = [message.body longValue];
    if ([message.name isEqual:@"ended"]) self.ended = YES;
}
@end

static void runWebCase(NSWindow *window, NSString *root, NSRect coverFrame) {
    SPPageEnd *page = [[SPPageEnd new] autorelease];
    WKWebViewConfiguration *configuration = [[WKWebViewConfiguration new] autorelease];
    [configuration.userContentController addScriptMessageHandler:page name:@"ended"];
    WKWebView *web = [[[WKWebView alloc] initWithFrame:window.contentView.bounds configuration:configuration] autorelease];
    [window.contentView addSubview:web];
    // Registered as a host registers its main web view, so the page keeps rendering while the window is covered.
    check(sp_window_set_main_webview(window, web) != NULL, @"web view: the web view is registered as a host registers it");
    NSMutableString *stripes = [NSMutableString string];
    for (int index = 0; index < 8; index++)
        [stripes appendFormat:@"<div id=s%d style='position:absolute;left:%dpx;top:0;width:40px;height:60px;background:#000'></div>",
            index, index * 40];
    [web loadHTMLString:[NSString stringWithFormat:@"<!doctype html><style>html,body{margin:0;background:#333;overflow:hidden}</style>"
        "%@<script>"
        "function paint(n){for(let i=0;i<8;i++)document.getElementById('s'+i).style.background=(n>>i)&1?'#fff':'#000'}"
        "function run(first,last){let n=first;function step(){paint(n);if(n===last){requestAnimationFrame(()=>"
        "window.webkit.messageHandlers.ended.postMessage(last));return}n++;requestAnimationFrame(step)}requestAnimationFrame(step)}"
        "paint(0)</script>", stripes] baseURL:nil];
    eventWait(@"web view: the page loads", ^BOOL { return !web.isLoading; });
    long cover = sp_person_window(coverFrame, 0xff00ff);
    check(cover >= 0 && sp_person_order_above(cover, window.windowNumber), @"web view: the window of the person covers the window");
    eventWait(@"web view: AppKit reports the covered window occluded", ^BOOL { return !shows(window); });
    for (int pass = 0; pass < 2; pass++) {
        BOOL control = pass == 1;
        NSString *name = control ? @"web view, control" : @"web view, covered";
        if (control) check(sp_person_close(cover), @"web view: the cover of the person closes");
        long first = control ? 1000 : 0, last = first + (control ? kControlChanges : kChanges) - 1;
        NSString *folder = [root stringByAppendingPathComponent:control ? @"web-control" : @"web-covered"];
        [NSFileManager.defaultManager createDirectoryAtPath:folder withIntermediateDirectories:NO attributes:nil error:NULL];
        page.ended = NO;
        __block BOOL covered = NO;
        SPRefreshes *watch = [[SPRefreshes new] autorelease];
        watch.tick = ^(CADisplayLink *link) { if (!shows(window)) covered = YES; };
        CADisplayLink *link = [window.contentView displayLinkWithTarget:watch selector:@selector(refresh:)];
        [link addToRunLoop:NSRunLoop.mainRunLoop forMode:NSRunLoopCommonModes];
        double from = 0, to = 0;
        BOOL stopEnded = NO;
        SPStretch *stretch = recordStretch(name, window, folder, first, last, ^(SPStretch *running) {
            [web evaluateJavaScript:[NSString stringWithFormat:@"run(%ld,%ld)", first, last] completionHandler:nil];
        }, ^BOOL { return page.ended; }, &from, &to, &stopEnded);
        [link invalidate];
        if (!stretch) continue;
        if (control && covered) {
            diagnostic(@"web view, control: other windows covered the window of the check at a refresh, so the control is not judged");
            continue;
        }
        judgeStretch(name, stretch, readFrames(folder), from, to, first, last, NO, stopEnded);
    }
    [web removeFromSuperview];
}

static void runNewWindowCase(NSWindow *under, NSString *root, NSRect coverFrame) {
    NSString *name = @"new window";
    long cover = sp_person_window(coverFrame, 0xff00ff);
    check(cover >= 0 && sp_person_order_above(cover, under.windowNumber), @"new window: the window of the person covers the place");
    NSWindow *window = makeWindow(under.frame);
    for (int index = 0; index < 8; index++) {
        CALayer *stripe = [CALayer layer];
        stripe.frame = stripeRect(index);
        stripe.backgroundColor = CGColorGetConstantColor((0x5a >> index) & 1 ? kCGColorWhite : kCGColorBlack);
        [window.contentView.layer addSublayer:stripe];
    }
    NSString *folder = [root stringByAppendingPathComponent:@"new-window"];
    [NSFileManager.defaultManager createDirectoryAtPath:folder withIntermediateDirectories:NO attributes:nil error:NULL];
    char *error = NULL;
    BOOL held = sp_capture_hold_new_window(&error);
    check(held, [NSString stringWithFormat:@"%@: the next show is held (%s)", name, error ?: ""]);
    free(error); error = NULL;
    if (!held) return;
    sp_window_show(window);
    uint64_t waitToken = nextToken();
    __block long shown = -1;
    dispatch_async(dispatch_get_global_queue(QOS_CLASS_USER_INITIATED, 0), ^{
        long number = sp_capture_wait_new_window(waitToken);
        dispatch_async(dispatch_get_main_queue(), ^{ shown = number; eventWake(); });
    });
    eventWait(@"new window: the held show is reported", ^BOOL { return shown != -1; });
    check(shown == window.windowNumber, @"new window: the held show is the window of the check");
    BOOL opened = sp_capture_open(window.windowNumber, false, nextToken(), &error);
    check(opened, [NSString stringWithFormat:@"%@: the recording opens the held window (%s)", name, error ?: ""]);
    free(error); error = NULL;
    BOOL started = opened && sp_capture_start(folder.fileSystemRepresentation, false, &error);
    check(started, [NSString stringWithFormat:@"%@: the recording starts and its start orders the window in (%s)", name, error ?: ""]);
    free(error);
    if (!started) { sp_capture_release_new_window(); [window close]; [window release]; return; }
    SPStretch *stretch = [[SPStretch new] autorelease];
    stretch.folder = folder;
    stretch.window = window.windowNumber;
    stretch.committed = -1;
    [stretch startStills];
    uint64_t token = nextToken();
    BOOL ended = NO;
    int first = awaitRecording(@"new window: the first frame of the recording", under.contentView, stretch, token,
        ^BOOL(Still still) { return still.low == 0x5a; },
        @"a still showed the new window and the display link ran 100 ms past it without a frame of the recording",
        ^int { return sp_capture_wait(token); }, &ended);
    Still seen = { 0, 0, -1, -1 };
    for (NSValue *value in stretch.stills) {
        Still still; [value getValue:&still];
        if (still.low == 0x5a) { seen = still; break; }
    }
    NSArray<NSValue *> *frames = readFrames(folder);
    Frame firstFrame = { 0, -1 };
    if (frames.count) [frames.firstObject getValue:&firstFrame];
    diagnostic([NSString stringWithFormat:@"new window: AppKit reports the window %@", shows(window) ? @"partly shown" : @"occluded"]);
    check(first == 1 && !ended && firstFrame.low == 0x5a && seen.ended > 0 && firstFrame.shown - seen.ended <= kLimitMs,
        [NSString stringWithFormat:@"%@: the first frame of the recording shows the window at most %.0f ms after a still showed it "
            "(first frame %@, a still showed it %@%@)", name, kLimitMs,
            frames.count ? [NSString stringWithFormat:@"at %.1f ms with %d", firstFrame.shown, firstFrame.low] : @"none",
            seen.ended > 0 ? [NSString stringWithFormat:@"at %.1f ms", seen.ended] : @"never",
            ended ? @"; the check ended the wait" : @""]);
    uint64_t stopToken = nextToken();
    double after = sp_capture_clock();
    awaitRecording(@"new window: the stop of the recording", under.contentView, stretch, stopToken,
        ^BOOL(Still still) { return still.low == 0x5a; },
        @"a still showed the new window and the display link ran 100 ms past it without a frame of the recording",
        ^int { return sp_capture_stop(after, stopToken); }, NULL);
    [stretch stopStills];
    [window close];
    [window release];
    sp_person_close(cover);
}

int main(int argc, char **argv) {
    int person = sp_person_child(argc, argv);
    if (person >= 0) return person;
    @autoreleasepool {
        fprintf(stderr, "START: covered window recording\n");
        [NSApplication sharedApplication];
        [NSApp setActivationPolicy:NSApplicationActivationPolicyProhibited];
        [NSApp finishLaunching];
        if (!sp_person_start(argv[0])) { check(NO, @"the person starts"); return 1; }
        NSString *root = temporaryFolder(@"soksak-capture-covered-stream-");
        NSRect frame = NSMakeRect(160, 160, kWidth, kHeight);
        NSRect coverFrame = NSInsetRect(frame, -80, -80);

        NSWindow *window = makeWindow(frame);
        [window orderBack:nil];
        [CATransaction flush];
        long cover = sp_person_window(coverFrame, 0xff00ff);
        check(cover >= 0 && sp_person_order_above(cover, window.windowNumber), @"layer: the window of the person covers the window");
        eventWait(@"layer: AppKit reports the covered window occluded", ^BOOL { return !shows(window); });
        runLayerCase(window, root, cover);
        [window close];
        [window release];

        window = makeWindow(frame);
        [window orderBack:nil];
        [CATransaction flush];
        runWebCase(window, root, coverFrame);
        runNewWindowCase(window, root, coverFrame);
        [window close];
        [window release];

        check(!NSApp.isActive && sp_person_active() == 0, @"neither the check nor the person became active");
        sp_person_end();
        if (failures) keepTemporaryFolder(root);
        fprintf(stderr, "%s: covered window recording\n", failures ? "FAIL" : "PASS");
    }
    return failures ? 1 : 0;
}
