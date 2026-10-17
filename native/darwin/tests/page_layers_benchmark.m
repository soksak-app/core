// Measures the graphics memory of the WebContent process of the main web view for six layer variants of the workbench
// page in a 1200×760 window. The graphics memory is the row "Owned physical footprint (unmapped) (graphics)" that footprint
// reports for the process. Each variant loads in a new web view, and the benchmark ends the process of that view before it
// starts the next variant. The benchmark prints the numbers and asserts nothing.
#import <Cocoa/Cocoa.h>
#import <WebKit/WebKit.h>
#import <signal.h>
#import <errno.h>
#import <string.h>
#import <sys/types.h>
#import "private/webkit.h"

static const CGFloat kWidth = 1200;
static const CGFloat kHeight = 760;
// The card rectangles that compositor.js cuts out of the background: x, y, w, h in CSS pixels of the viewport.
static const int kCards[3][4] = { { 20, 60, 560, 340 }, { 600, 60, 580, 340 }, { 20, 420, 1160, 320 } };
// Waits at most this many seconds for each step (AGENTS: a step that cannot finish is reported with its measured state).
static const NSTimeInterval stepLimit = 120;
// Each variant is loaded this many times. The median of the samples is reported.
enum { kSamples = 3 };
// The page settles for this long after two animation frames, so that its layers are committed before the read.
static const NSTimeInterval settleSeconds = 1;

typedef struct {
    const char *name;
    const char *label;
    BOOL transparent; // body is transparent and body::before paints the fixed full-window background
    BOOL isolated;    // body has isolation:isolate
    BOOL clipped;     // the paint clip of compositor.js cuts the card rectangles out of body::before
    BOOL rail;        // a full-size absolute SVG overlay
    BOOL spinner;     // one running spinner animation
} Variant;

static const Variant kVariants[] = {
    { "A", "opaque page, no fixed background (baseline)", NO, NO, NO, NO, NO },
    { "B", "transparent body and fixed body::before background", YES, YES, NO, NO, NO },
    { "C", "B and the paint clip of three card rectangles", YES, YES, YES, NO, NO },
    { "D", "C and a full-size rail SVG overlay", YES, YES, YES, YES, NO },
    { "E", "D and one running spinner animation", YES, YES, YES, YES, YES },
    { "F", "B without isolation:isolate", YES, NO, NO, NO, NO },
};

static double nowSeconds(void) {
    return NSDate.date.timeIntervalSince1970;
}

// Pumps the run loop until done() holds or the limit passes. Returns done().
static BOOL pumpUntil(NSTimeInterval limit, BOOL (^done)(void)) {
    NSDate *deadline = [NSDate dateWithTimeIntervalSinceNow:limit];
    while (!done() && deadline.timeIntervalSinceNow > 0) {
        [[NSRunLoop currentRunLoop] runMode:NSDefaultRunLoopMode beforeDate:[NSDate dateWithTimeIntervalSinceNow:0.01]];
    }
    return done();
}

// Exits with the step and the measured state when a step cannot run. The WebContent process of the view ends first.
static void failStep(NSString *step, NSString *reason, WKWebView *view) {
    pid_t process = view ? view._webProcessIdentifier : 0;
    fprintf(stderr, "FAIL: step %s: %s\n", step.UTF8String, reason.UTF8String);
    fprintf(stderr, "  state: pid=%d\n", process);
    if (process != 0) kill(process, SIGKILL);
    exit(1);
}

// The HTML of a variant. Each rule has the form that the workbench page uses (app.css and compositor.js).
static NSString *pageFor(const Variant *variant) {
    NSMutableString *html = [NSMutableString stringWithString:
        @"<!doctype html><meta charset=\"utf-8\"><title>Layers</title><style>"
        "html,body{height:100%}"
        "body{margin:0;display:flex;flex-direction:column;overflow:hidden;font:13px/1.4 sans-serif;color:#d8dce3;word-break:keep-all}"];
    if (variant->transparent) {
        [html appendString:@"body{background:transparent"];
        if (variant->isolated) [html appendString:@";isolation:isolate"];
        [html appendString:@"}"
            "body::before{content:\"\";position:fixed;inset:0;z-index:-1;pointer-events:none;background:#1b1d21}"];
    } else {
        [html appendString:@"body{background:#1b1d21}"];
    }
    if (variant->rail) {
        [html appendString:@".rail{position:absolute;inset:0;z-index:3;pointer-events:none;overflow:visible}"
            ".rail path{fill:none;stroke:#5c6373;stroke-width:1;stroke-linejoin:round;vector-effect:non-scaling-stroke}"];
    }
    if (variant->spinner) {
        [html appendString:@".spin{position:absolute;left:8px;top:8px;width:8px;height:8px;border:1px solid #d8dce3;"
            "border-top-color:transparent;border-radius:50%;animation:spin .8s linear infinite}"
            "@keyframes spin{to{transform:rotate(360deg)}}"];
    }
    [html appendString:@"</style>"];
    if (variant->clipped) {
        // The same form as compositor.js: each hole is a subpath wound opposite to the outer rectangle, and the clip
        // rule is applied to body::before only.
        NSMutableString *holes = [NSMutableString string];
        for (int i = 0; i < 3; i++) {
            [holes appendFormat:@"M%d,%dv%dh%dv%dZ", kCards[i][0], kCards[i][1], kCards[i][3], kCards[i][2], -kCards[i][3]];
        }
        [html appendFormat:@"<style data-native-paint-clip>body::before{clip-path:path(\"M0,0H%dV%dH0Z%@\")}</style>",
            (int)kWidth, (int)kHeight, holes];
    }
    [html appendString:@"<body>"];
    if (variant->rail) {
        [html appendString:@"<svg class=\"rail\" width=\"1200\" height=\"760\" viewBox=\"0 0 1200 760\">"
            "<path d=\"M20,60H580V400H20Z M600,60H1180V400H600Z M20,420H1180V740H20Z\"/></svg>"];
    }
    if (variant->spinner) [html appendString:@"<span class=\"spin\"></span>"];
    [html appendString:@"</body>"];
    return html;
}

// The graphics memory (bytes) of the process, read from the row of footprint that names it, or -1 when footprint does not report it.
static long graphicsBytes(pid_t pid) {
    NSTask *task = [[[NSTask alloc] init] autorelease];
    task.executableURL = [NSURL fileURLWithPath:@"/usr/bin/footprint"];
    task.arguments = @[@"-p", [NSString stringWithFormat:@"%d", pid], @"-f", @"bytes"];
    NSPipe *pipe = [NSPipe pipe];
    task.standardOutput = pipe;
    NSError *error = nil;
    if (![task launchAndReturnError:&error]) {
        fprintf(stderr, "footprint cannot start: %s\n", error.localizedDescription.UTF8String);
        return -1;
    }
    NSData *data = [pipe.fileHandleForReading readDataToEndOfFile];
    [task waitUntilExit];
    if (task.terminationStatus != 0) return -1;
    NSString *text = [[[NSString alloc] initWithData:data encoding:NSUTF8StringEncoding] autorelease];
    for (NSString *line in [text componentsSeparatedByString:@"\n"]) {
        if ([line rangeOfString:@"Owned physical footprint (unmapped) (graphics)"].location == NSNotFound) continue;
        // The first column of the row is the dirty size in bytes, written as "<number> B".
        long bytes = 0;
        return sscanf(line.UTF8String, " %ld B", &bytes) == 1 ? bytes : -1;
    }
    return -1;
}

// Loads one variant in a new web view, reads the graphics memory of its WebContent process, and ends that process.
static long measureVariant(NSView *content, const Variant *variant, int sample) {
    NSString *step = [NSString stringWithFormat:@"variant %s sample %d", variant->name, sample];
    fprintf(stdout, "start %s sample %d of %d: %s\n", variant->name, sample, kSamples, variant->label);
    fflush(stdout);
    double started = nowSeconds();
    pid_t process = 0;
    long graphics = -1;
    @autoreleasepool {
        WKWebView *view = [[[WKWebView alloc] initWithFrame:content.bounds] autorelease];
        // The main web view of the application: the transparent backing of configureWebViewTransparency in
        // webview_geometry.m, and the occlusion detection that the main web view turns off.
        view.underPageBackgroundColor = NSColor.clearColor;
        [view setValue:@NO forKey:@"drawsBackground"];
        view.wantsLayer = YES;
        view.layer.opaque = NO;
        view.layer.backgroundColor = NSColor.clearColor.CGColor;
        view._windowOcclusionDetectionEnabled = NO;
        [content addSubview:view];

        NSString *html = pageFor(variant);
        [view loadHTMLString:html baseURL:nil];
        if (!pumpUntil(stepLimit, ^BOOL { return !view.loading && [view.title isEqual:@"Layers"]; })) {
            failStep(step, @"the page did not load within 120 seconds", view);
        }

        // Two animation frames reported by the page show that the page has presented its first frame.
        __block BOOL framed = NO;
        __block NSError *failure = nil;
        [view callAsyncJavaScript:@"await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))); return true;"
            arguments:@{} inFrame:nil inContentWorld:WKContentWorld.pageWorld completionHandler:^(id value, NSError *error) {
            failure = [error retain];
            framed = YES;
        }];
        if (!pumpUntil(stepLimit, ^BOOL { return framed; })) {
            failStep(step, @"the page did not report two animation frames within 120 seconds", view);
        }
        if (failure) failStep(step, [NSString stringWithFormat:@"the page script failed: %@", failure.localizedDescription], view);
        pumpUntil(settleSeconds, ^BOOL { return NO; });

        process = view._webProcessIdentifier;
        if (process == 0) failStep(step, @"the web view has no WebContent process", view);
        graphics = graphicsBytes(process);
        if (graphics < 0) {
            failStep(step, @"footprint did not report the row Owned physical footprint (unmapped) (graphics)", view);
        }

        // The view ends with this pool. The WebContent process of the view is ended here, because WebKit keeps an idle process.
        [view removeFromSuperview];
        if (kill(process, SIGKILL) != 0 && errno != ESRCH) {
            failStep(step, [NSString stringWithFormat:@"the WebContent process %d cannot be ended: %s", process, strerror(errno)], nil);
        }
    }
    if (!pumpUntil(10, ^BOOL { return kill(process, 0) != 0; })) {
        fprintf(stderr, "FAIL: step %s: the WebContent process %d remains after 10 seconds\n", step.UTF8String, process);
        exit(1);
    }
    fprintf(stdout, "end %s sample %d elapsed %.3f s\n", variant->name, sample, nowSeconds() - started);
    fflush(stdout);
    return graphics;
}

int main(void) { @autoreleasepool {
    double started = nowSeconds();
    fprintf(stdout, "start benchmark\n");
    fflush(stdout);
    [NSApplication sharedApplication];
    [NSApp setActivationPolicy:NSApplicationActivationPolicyProhibited];
    [NSApp finishLaunching];
    [NSApp setActivationPolicy:NSApplicationActivationPolicyAccessory];

    NSWindow *window = [[NSWindow alloc] initWithContentRect:NSMakeRect(100, 100, kWidth, kHeight)
        styleMask:NSWindowStyleMaskTitled backing:NSBackingStoreBuffered defer:NO];
    [window setReleasedWhenClosed:NO];
    NSView *content = [[[NSView alloc] initWithFrame:NSMakeRect(0, 0, kWidth, kHeight)] autorelease];
    window.contentView = content;
    // orderBack does not activate the application.
    [window orderBack:nil];

    // One window-sized buffer is the window size in window pixels (the size of the web view) at 16 bytes per pixel. The
    // backing scale is printed for reference; the buffer size does not include it.
    CGFloat scale = window.backingScaleFactor;
    long windowBuffer = (long)kWidth * (long)kHeight * 16;
    fprintf(stdout, "window %gx%g scale %g window_buffer_bytes %ld (%.2f MB)\n", (double)kWidth, (double)kHeight,
        (double)scale, windowBuffer, windowBuffer / 1048576.0);
    fflush(stdout);

    // Each variant is measured kSamples times, each time in a new web view. A variant is reported by the median of its
    // samples, because a single read alternates between one and two buffers for the same page.
    size_t count = sizeof(kVariants) / sizeof(kVariants[0]);
    long medians[sizeof(kVariants) / sizeof(kVariants[0])];
    for (size_t i = 0; i < count; i++) {
        long samples[kSamples];
        for (int s = 0; s < kSamples; s++) {
            samples[s] = measureVariant(content, &kVariants[i], s + 1);
            fprintf(stdout, "sample %s %d graphics_mb %.1f graphics_bytes %ld\n", kVariants[i].name, s + 1,
                samples[s] / 1048576.0, samples[s]);
            fflush(stdout);
        }
        for (int a = 1; a < kSamples; a++) {
            for (int b = a; b > 0 && samples[b - 1] > samples[b]; b--) {
                long swap = samples[b - 1];
                samples[b - 1] = samples[b];
                samples[b] = swap;
            }
        }
        medians[i] = samples[kSamples / 2];
    }
    long baseline = medians[0];
    for (size_t i = 0; i < count; i++) {
        fprintf(stdout, "variant %s graphics_mb %.1f graphics_bytes %ld delta_to_A_mb %.1f delta_to_A_window_buffers %.2f\n",
            kVariants[i].name, medians[i] / 1048576.0, medians[i], (medians[i] - baseline) / 1048576.0,
            (double)(medians[i] - baseline) / (double)windowBuffer);
        fflush(stdout);
    }

    [window close];
    [window release];
    fprintf(stdout, "end benchmark elapsed %.3f s\n", nowSeconds() - started);
    fflush(stdout);
    return 0;
}}
