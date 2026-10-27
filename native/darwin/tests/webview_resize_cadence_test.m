// Measures root-view ResizeObserver-to-animation-frame cadence against native display-paced frame changes.
// The check records the real window/document visibility and screen refresh state without activating the application
// or changing WebKit's rendering policy.
#import <Cocoa/Cocoa.h>
#import <CoreGraphics/CGWindow.h>
#import <QuartzCore/QuartzCore.h>
#import <WebKit/WebKit.h>
#import "document_view.h"
#import "surface_layout.h"
#import "support/temporary_folder.h"
#import "webview_geometry.h"

static int failures;
static const NSUInteger resizeSteps = 48;
static const double resizeBaseWidth = 300;
static const double resizeBaseHeight = 200;
static const double contentIntervalLimitMs = 33.0;

static void check(BOOL condition, NSString *message) {
    fprintf(condition ? stdout : stderr, "%s: %s\n", condition ? "PASS" : "FAIL", message.UTF8String);
    if (!condition) failures++;
}

// WindowServer occlusion changes arrive as AppKit events. Process window and screen events without taking application
// activation events so the inactive fixture observes the same state changes as production windows.
static void pumpOcclusion(void) {
    NSEvent *event = [NSApp nextEventMatchingMask:NSEventMaskAppKitDefined
        untilDate:[NSDate dateWithTimeIntervalSinceNow:0.02] inMode:NSDefaultRunLoopMode dequeue:NO];
    if (event && event.subtype != NSEventSubtypeApplicationActivated
        && event.subtype != NSEventSubtypeApplicationDeactivated) {
        [NSApp sendEvent:[NSApp nextEventMatchingMask:NSEventMaskAppKitDefined untilDate:nil
            inMode:NSDefaultRunLoopMode dequeue:YES]];
    }
    [NSRunLoop.currentRunLoop runMode:NSDefaultRunLoopMode
        beforeDate:[NSDate dateWithTimeIntervalSinceNow:0.01]];
}

@class SPResizeCadenceReceiver;
static void changed(void *context, const char *state);

static void until(BOOL (^done)(void), NSString *reason) {
    NSDate *deadline = [NSDate dateWithTimeIntervalSinceNow:12];
    while (!done() && deadline.timeIntervalSinceNow > 0) {
        pumpOcclusion();
    }
    if (!done()) {
        fprintf(stderr, "FAIL: %s within 12 seconds\n", reason.UTF8String);
        exit(1);
    }
}

@interface SPResizeCadenceReceiver : NSObject <WKScriptMessageHandler>
@property(nonatomic, assign) WKWebView *view;
@property(nonatomic, retain) NSMutableArray<NSDictionary *> *frames;
@property(nonatomic, retain) NSMutableArray<NSNumber *> *nativeWidths;
@property(nonatomic, retain) NSMutableArray<NSDictionary *> *displayTicks;
@property(nonatomic, assign) void *surface;
@property(nonatomic, assign) NSUInteger tickCount;
@property(nonatomic, assign) NSUInteger stepLimit;
@property(nonatomic, assign) double baseWidth;
@property(nonatomic, assign) BOOL ready;
@property(nonatomic, assign) BOOL done;
@property(nonatomic, assign) NSUInteger occlusionNotifications;
@property(nonatomic, retain) NSString *documentVisibility;
@property(nonatomic, retain) NSString *documentState;
@property(nonatomic, retain) NSNumber *baselineWidth;
@property(nonatomic, retain) NSNumber *baselineHeight;
@property(nonatomic, retain) NSNumber *baselineResizeAtMs;
@property(nonatomic, retain) NSNumber *baselineFrameTimeMs;
@end

@implementation SPResizeCadenceReceiver
- (instancetype)init {
    if ((self = [super init])) {
        _frames = [[NSMutableArray alloc] init];
        _nativeWidths = [[NSMutableArray alloc] init];
        _displayTicks = [[NSMutableArray alloc] init];
    }
    return self;
}
- (void)userContentController:(WKUserContentController *)controller didReceiveScriptMessage:(WKScriptMessage *)message {
    if ([message.body isKindOfClass:NSDictionary.class] && [message.body[@"ready"] boolValue]) {
        self.documentVisibility = message.body[@"visibility"];
        self.baselineWidth = message.body[@"width"];
        self.baselineHeight = message.body[@"height"];
        self.baselineResizeAtMs = message.body[@"resizeAtMs"];
        self.baselineFrameTimeMs = message.body[@"frameTimeMs"];
        check([self.baselineWidth isKindOfClass:NSNumber.class]
            && [self.baselineHeight isKindOfClass:NSNumber.class]
            && [self.baselineResizeAtMs isKindOfClass:NSNumber.class]
            && [self.baselineFrameTimeMs isKindOfClass:NSNumber.class]
            && self.baselineWidth.doubleValue == resizeBaseWidth
            && self.baselineHeight.doubleValue == resizeBaseHeight,
            @"baseline readiness follows an actual ResizeObserver-to-rAF row at the native pulse base size");
        self.ready = YES;
        return;
    }
    if ([message.body isKindOfClass:NSDictionary.class] && [message.body[@"done"] boolValue]) {
        self.done = YES;
        return;
    }
    if ([message.body isKindOfClass:NSDictionary.class] && [message.body[@"visibility"] isKindOfClass:NSString.class]) {
        self.documentVisibility = message.body[@"visibility"];
        return;
    }
    if (![message.body isKindOfClass:NSDictionary.class]) {
        check(NO, [NSString stringWithFormat:@"unexpected resize observation message: %@", message.body]);
        return;
    }
    NSDictionary *body = message.body;
    NSNumber *width = body[@"width"];
    NSNumber *firstResize = body[@"firstResizeAtMs"];
    NSNumber *resizeAt = body[@"resizeAtMs"];
    NSNumber *resizeCount = body[@"resizeCount"];
    NSNumber *frameTime = body[@"frameTimeMs"];
    NSString *visibility = body[@"visibility"];
    if (![width isKindOfClass:NSNumber.class] || ![firstResize isKindOfClass:NSNumber.class]
        || ![resizeAt isKindOfClass:NSNumber.class] || ![resizeCount isKindOfClass:NSNumber.class]
        || ![frameTime isKindOfClass:NSNumber.class] || ![visibility isKindOfClass:NSString.class]) {
        check(NO, [NSString stringWithFormat:@"resize observation is incomplete: %@", body]);
        return;
    }
    [self.frames addObject:@{ @"width": width, @"firstResizeAtMs": firstResize, @"resizeAtMs": resizeAt,
        @"resizeCount": resizeCount, @"frameTimeMs": frameTime, @"visibility": visibility }];
}
- (void)windowDidChangeOcclusionState:(NSNotification *)notification {
    self.occlusionNotifications++;
}
- (void)tick:(CADisplayLink *)link {
    double width = self.baseWidth + self.tickCount + 1;
    [self.nativeWidths addObject:@(width)];
    double appliedBeforeMs = CACurrentMediaTime() * 1000;
    webviewSetFrame(self.surface, 40, 30, width, 200);
    double appliedAfterMs = CACurrentMediaTime() * 1000;
    [self.displayTicks addObject:@{ @"timestampMs": @(link.timestamp * 1000),
        @"targetTimestampMs": @(link.targetTimestamp * 1000),
        @"appliedBeforeMs": @(appliedBeforeMs), @"appliedAfterMs": @(appliedAfterMs) }];
    self.tickCount++;
    if (self.tickCount >= self.stepLimit) [link invalidate];
}
- (void)dealloc {
    [_frames release];
    [_nativeWidths release];
    [_displayTicks release];
    [_documentVisibility release];
    [_documentState release];
    [_baselineWidth release];
    [_baselineHeight release];
    [_baselineResizeAtMs release];
    [_baselineFrameTimeMs release];
    [super dealloc];
}
@end

static void changed(void *context, const char *state) {
    SPResizeCadenceReceiver *receiver = (SPResizeCadenceReceiver *)context;
    receiver.documentState = state ? [NSString stringWithUTF8String:state] : @"(null)";
}

static NSDictionary *windowServerState(NSWindow *window) {
    CFArrayRef entries = CGWindowListCopyWindowInfo(kCGWindowListOptionOnScreenOnly, kCGNullWindowID);
    NSMutableArray *above = [NSMutableArray array];
    NSDictionary *target = nil;
    NSUInteger index = NSNotFound;
    for (NSUInteger position = 0; entries && position < CFArrayGetCount(entries); position++) {
        NSDictionary *entry = (NSDictionary *)CFArrayGetValueAtIndex(entries, position);
        if ([entry[@"kCGWindowNumber"] unsignedIntValue] == window.windowNumber) {
            target = entry;
            index = position;
            break;
        }
        [above addObject:@{
            @"owner": entry[@"kCGWindowOwnerName"] ?: @"unknown",
            @"layer": entry[@"kCGWindowLayer"] ?: @(-1),
            @"bounds": entry[@"kCGWindowBounds"] ?: @{},
        }];
    }
    NSScreen *screen = window.screen;
    NSDictionary *result = @{
        @"windowNumber": @(window.windowNumber), @"windowFrame": NSStringFromRect(window.frame),
        @"screenFrame": screen ? NSStringFromRect(screen.frame) : @"none",
        @"visibleFrame": screen ? NSStringFromRect(screen.visibleFrame) : @"none",
        @"windowServerIndex": index == NSNotFound ? @"not-on-screen" : @(index),
        @"windowServerLayer": target[@"kCGWindowLayer"] ?: @"unavailable",
        @"windowServerBounds": target[@"kCGWindowBounds"] ?: @{}, @"windowsAbove": above,
    };
    if (entries) CFRelease(entries);
    return result;
}

static NSDictionary *parsedDocumentState(SPResizeCadenceReceiver *receiver) {
    if (!receiver.documentState) return nil;
    NSData *data = [receiver.documentState dataUsingEncoding:NSUTF8StringEncoding];
    NSError *error = nil;
    id state = data ? [NSJSONSerialization JSONObjectWithData:data options:0 error:&error] : nil;
    if (![state isKindOfClass:NSDictionary.class]) {
        fprintf(stderr, "FAIL: document state must be a JSON object: %s (%s)\n",
            receiver.documentState.UTF8String, error.localizedDescription.UTF8String ?: "unexpected JSON type");
        exit(1);
    }
    return state;
}

static NSString *stateFor(NSWindow *window, SPResizeCadenceReceiver *receiver, NSView *surface, WKWebView *view) {
    return [NSString stringWithFormat:
        @"visible=%d occlusionVisible=%d activeSpace=%d appActive=%d activationPolicy=%ld documentVisibility=%@ refreshHz=%ld occlusionNotifications=%lu surfaceHidden=%d rootHidden=%d rootAncestorHidden=%d nativeSteps=%lu sourceFrames=%lu nativeDocumentState=%@ windowServer=%@",
        window.isVisible, (window.occlusionState & NSWindowOcclusionStateVisible) != 0, window.isOnActiveSpace,
        NSApp.isActive, (long)NSApp.activationPolicy, receiver.documentVisibility ?: @"unknown", (long)window.screen.maximumFramesPerSecond,
        (unsigned long)receiver.occlusionNotifications, surface.hidden, view.hidden, view.isHiddenOrHasHiddenAncestor,
        (unsigned long)receiver.nativeWidths.count,
        (unsigned long)receiver.frames.count, receiver.documentState ?: @"unknown", windowServerState(window)];
}

static id evaluate(WKWebView *view, NSString *script) {
    __block BOOL done = NO;
    __block id result = nil;
    [view evaluateJavaScript:script completionHandler:^(id value, NSError *error) {
        if (error) fprintf(stderr, "JavaScript evaluation failed: %s\n", error.localizedDescription.UTF8String);
        result = [value retain];
        done = YES;
    }];
    NSDate *deadline = [NSDate dateWithTimeIntervalSinceNow:12];
    while (!done && deadline.timeIntervalSinceNow > 0) {
        pumpOcclusion();
    }
    if (!done) {
        fprintf(stderr, "FAIL: JavaScript evaluation completed within 12 seconds\n");
        exit(1);
    }
    return [result autorelease];
}

static void runCadenceCase(NSString *name, NSWindow *window, WKWebView *view,
    SPResizeCadenceReceiver *receiver) {
    receiver.frames = [NSMutableArray array];
    receiver.nativeWidths = [NSMutableArray array];
    receiver.displayTicks = [NSMutableArray array];
    receiver.tickCount = 0;
    receiver.stepLimit = resizeSteps;
    receiver.baseWidth = resizeBaseWidth;
    receiver.done = NO;

    NSString *state = stateFor(window, receiver, (NSView *)receiver.surface, view);
    fprintf(stdout, "RUNNING: %s (%s)\n", name.UTF8String, state.UTF8String);
    BOOL correctWindowState = window.isVisible
        && (window.occlusionState & NSWindowOcclusionStateVisible) != 0
        && window.isOnActiveSpace
        && window.screen.maximumFramesPerSecond > 0
        && !NSApp.isActive && [receiver.documentVisibility isEqualToString:@"visible"]
        && !((NSView *)receiver.surface).hidden && !view.isHiddenOrHasHiddenAncestor
        && !view.hidden && !view.superview.hidden;
    check(correctWindowState, [NSString stringWithFormat:
        @"%@ observes a fully visible inactive window, visible logical surface/root and screen refresh rate (%@; rootHidden=%d rootAncestorHidden=%d)",
        name, state, view.hidden, view.isHiddenOrHasHiddenAncestor]);
    if (!correctWindowState) return;

    NSScreen *screen = window.screen;
    check(screen != nil, @"the visible test window has a screen for its display link");
    if (!screen) return;
    CADisplayLink *link = [[screen displayLinkWithTarget:receiver selector:@selector(tick:)] retain];
    [link addToRunLoop:NSRunLoop.mainRunLoop forMode:NSRunLoopCommonModes];
    until(^BOOL { return receiver.tickCount == resizeSteps; }, [NSString stringWithFormat:@"%@ native display-paced resize steps", name]);
    until(^BOOL { return receiver.done; }, [NSString stringWithFormat:@"%@ final ResizeObserver-to-rAF row", name]);
    [link invalidate];
    [link release];
    id rows = evaluate(view, @"window.cadenceFrames");
    if (![rows isKindOfClass:NSArray.class]) {
        check(NO, [NSString stringWithFormat:@"%@ returns recorded ResizeObserver rows (%@)", name, rows]);
        return;
    }
    receiver.frames = [[rows mutableCopy] autorelease];
    BOOL baselinePreserved = receiver.frames.count > 0
        && [receiver.frames[0][@"width"] doubleValue] == receiver.baselineWidth.doubleValue
        && [receiver.frames[0][@"height"] doubleValue] == receiver.baselineHeight.doubleValue
        && [receiver.frames[0][@"resizeAtMs"] doubleValue] == receiver.baselineResizeAtMs.doubleValue
        && [receiver.frames[0][@"frameTimeMs"] doubleValue] == receiver.baselineFrameTimeMs.doubleValue;
    check(baselinePreserved, [NSString stringWithFormat:
        @"%@ preserves the initial source row before the native resize pulses (baseline %.3f×%.3f/%.3f/%.3f; first row %@)",
        name, receiver.baselineWidth.doubleValue, receiver.baselineHeight.doubleValue, receiver.baselineResizeAtMs.doubleValue,
        receiver.baselineFrameTimeMs.doubleValue, receiver.frames.firstObject ?: @"missing"]);

    NSUInteger firstPulseFrameIndex = NSNotFound;
    // The baseline-to-first-response interval includes idle time before the first pulse. The cadence contract covers
    // consecutive source rows after the first pulse response; the first-pulse response latency remains unmeasured.
    for (NSUInteger index = 0; index < receiver.frames.count; index++) {
        if ([receiver.frames[index][@"width"] doubleValue] != receiver.baselineWidth.doubleValue) {
            firstPulseFrameIndex = index;
            break;
        }
    }
    NSMutableArray<NSNumber *> *gaps = [NSMutableArray array];
    NSMutableArray<NSNumber *> *missingWidths = [NSMutableArray array];
    NSUInteger nativeIndex = 0;
    NSUInteger observedPulseWidths = 0;
    for (NSUInteger index = 0; index < receiver.frames.count; index++) {
        NSDictionary *frame = receiver.frames[index];
        double width = [frame[@"width"] doubleValue];
        if (firstPulseFrameIndex != NSNotFound && index >= firstPulseFrameIndex) {
            while (nativeIndex < receiver.nativeWidths.count
                && receiver.nativeWidths[nativeIndex].doubleValue < width) {
                [missingWidths addObject:receiver.nativeWidths[nativeIndex]];
                nativeIndex++;
            }
            if (nativeIndex < receiver.nativeWidths.count
                && receiver.nativeWidths[nativeIndex].doubleValue == width) {
                nativeIndex++;
                observedPulseWidths++;
            }
        }
        if ([frame[@"visibility"] isEqualToString:@"visible"] == NO) {
            check(NO, [NSString stringWithFormat:@"%@ document visibility remains visible (%@)", name, frame]);
        }
    }
    while (nativeIndex < receiver.nativeWidths.count) {
        [missingWidths addObject:receiver.nativeWidths[nativeIndex++]];
    }
    double maxResizeGap = 0, maxRafWait = 0;
    for (NSDictionary *frame in receiver.frames) {
        maxRafWait = MAX(maxRafWait, [frame[@"frameTimeMs"] doubleValue] - [frame[@"resizeAtMs"] doubleValue]);
    }
    for (NSUInteger index = 1; index < receiver.frames.count; index++) {
        double previous = [receiver.frames[index - 1][@"frameTimeMs"] doubleValue];
        double current = [receiver.frames[index][@"frameTimeMs"] doubleValue];
        double previousResize = [receiver.frames[index - 1][@"resizeAtMs"] doubleValue];
        double currentResize = [receiver.frames[index][@"resizeAtMs"] doubleValue];
        maxResizeGap = MAX(maxResizeGap, currentResize - previousResize);
        if (current <= previous) {
            check(NO, [NSString stringWithFormat:@"%@ source frame times increase (%@ -> %@)", name,
                receiver.frames[index - 1], receiver.frames[index]]);
            continue;
        }
        [gaps addObject:@(current - previous)];
    }
    check(firstPulseFrameIndex != NSNotFound && firstPulseFrameIndex > 0,
        [NSString stringWithFormat:@"%@ records its baseline before the first native resize pulse (baseline %.3f; first pulse row %@)",
        name, receiver.baselineWidth.doubleValue,
        firstPulseFrameIndex == NSNotFound ? @"missing" : receiver.frames[firstPulseFrameIndex]]);
    NSMutableArray<NSNumber *> *pulseGaps = [NSMutableArray array];
    if (firstPulseFrameIndex != NSNotFound) {
        for (NSUInteger index = firstPulseFrameIndex + 1; index < receiver.frames.count; index++) {
            double previous = [receiver.frames[index - 1][@"frameTimeMs"] doubleValue];
            double current = [receiver.frames[index][@"frameTimeMs"] doubleValue];
            if (current > previous) [pulseGaps addObject:@(current - previous)];
        }
    }
    double maxGap = 0;
    for (NSNumber *gap in pulseGaps) maxGap = MAX(maxGap, gap.doubleValue);
    double maxAllGap = 0;
    for (NSNumber *gap in gaps) maxAllGap = MAX(maxAllGap, gap.doubleValue);
    NSUInteger pulseSourceRows = firstPulseFrameIndex == NSNotFound ? 0 : receiver.frames.count - firstPulseFrameIndex;
    double baselineToFirstPulseMs = firstPulseFrameIndex == NSNotFound ? 0
        : [receiver.frames[firstPulseFrameIndex][@"frameTimeMs"] doubleValue] - receiver.baselineFrameTimeMs.doubleValue;
    NSMutableArray *displayGaps = [NSMutableArray array];
    for (NSUInteger index = 1; index < receiver.displayTicks.count; index++) {
        double previous = [receiver.displayTicks[index - 1][@"targetTimestampMs"] doubleValue];
        double current = [receiver.displayTicks[index][@"targetTimestampMs"] doubleValue];
        if (current > previous) [displayGaps addObject:@(current - previous)];
    }
    double maxDisplayGap = 0;
    for (NSNumber *gap in displayGaps) maxDisplayGap = MAX(maxDisplayGap, gap.doubleValue);
    NSMutableArray<NSNumber *> *appliedGaps = [NSMutableArray array];
    for (NSUInteger index = 1; index < receiver.displayTicks.count; index++) {
        double previous = [receiver.displayTicks[index - 1][@"appliedBeforeMs"] doubleValue];
        double current = [receiver.displayTicks[index][@"appliedBeforeMs"] doubleValue];
        if (current > previous) [appliedGaps addObject:@(current - previous)];
    }
    double maxAppliedGap = 0;
    for (NSNumber *gap in appliedGaps) maxAppliedGap = MAX(maxAppliedGap, gap.doubleValue);
    BOOL enoughFrames = receiver.frames.count >= 2;
    check(enoughFrames && pulseGaps.count > 0, [NSString stringWithFormat:
        @"%@ produces source content rows after baseline for cadence measurement (%lu rows; %@)", name,
        (unsigned long)receiver.frames.count, stateFor(window, receiver, (NSView *)receiver.surface, view)]);
    if (enoughFrames && pulseGaps.count > 0) {
        check(maxGap <= contentIntervalLimitMs, [NSString stringWithFormat:
            @"%@ RO-to-next-rAF source cadence is at most %.0f ms during native resize pulses (max %.3f ms; baseline-to-first-pulse %.3f ms outside pulse cadence; RO max %.3f ms; RAF wait max %.3f ms; predicted display max %.3f ms; actual setter max %.3f ms; %lu/%lu widths observed; missing %@; %@)",
            name, contentIntervalLimitMs, maxGap, baselineToFirstPulseMs, maxResizeGap, maxRafWait, maxDisplayGap, maxAppliedGap,
            (unsigned long)observedPulseWidths,
            (unsigned long)receiver.nativeWidths.count, missingWidths,
            stateFor(window, receiver, (NSView *)receiver.surface, view)]);
    }
    fprintf(stdout, "PULSE: %s startTimestampMs=%.3f firstWidth=%.0f endTimestampMs=%.3f lastWidth=%.0f maxAppliedSetterGapMs=%.3f baselineWidth=%.3f baselineHeight=%.3f baselineResizeAtMs=%.3f baselineFrameTimeMs=%.3f baselineToFirstPulseFrameMs=%.3f\n",
        name.UTF8String, [receiver.displayTicks.firstObject[@"timestampMs"] doubleValue], receiver.nativeWidths.firstObject.doubleValue,
        [receiver.displayTicks.lastObject[@"timestampMs"] doubleValue], receiver.nativeWidths.lastObject.doubleValue,
        maxAppliedGap, receiver.baselineWidth.doubleValue, receiver.baselineHeight.doubleValue,
        receiver.baselineResizeAtMs.doubleValue, receiver.baselineFrameTimeMs.doubleValue,
        baselineToFirstPulseMs);
    fprintf(stdout, "FINISHED: %s sourceRows=%lu pulseSourceRows=%lu maxPulseSourceGapMs=%.3f maxAllSourceGapMs=%.3f maxResizeGapMs=%.3f maxRafWaitMs=%.3f maxDisplayGapMs=%.3f nativeWidths=%lu pulseWidthsObserved=%lu missingPulseWidths=%s (%s)\n",
        name.UTF8String, (unsigned long)receiver.frames.count, (unsigned long)pulseSourceRows, maxGap, maxAllGap,
        maxResizeGap, maxRafWait, maxDisplayGap,
        (unsigned long)receiver.nativeWidths.count, (unsigned long)observedPulseWidths,
        missingWidths.description.UTF8String, stateFor(window, receiver, (NSView *)receiver.surface, view).UTF8String);
    fprintf(stdout, "RAW: %s nativeWidths=%s sourceFrames=%s displayTicks=%s\n", name.UTF8String,
        receiver.nativeWidths.description.UTF8String, receiver.frames.description.UTF8String,
        receiver.displayTicks.description.UTF8String);
}

int main(void) { @autoreleasepool {
    [NSApplication sharedApplication];
    [NSApp setActivationPolicy:NSApplicationActivationPolicyProhibited];
    [NSApp finishLaunching];
    [NSApp setActivationPolicy:NSApplicationActivationPolicyAccessory];
    NSWindow *window = [[[NSWindow alloc] initWithContentRect:NSMakeRect(100, 100, 500, 360)
        styleMask:NSWindowStyleMaskBorderless backing:NSBackingStoreBuffered defer:NO] autorelease];
    [window setReleasedWhenClosed:NO];
    window.animationBehavior = NSWindowAnimationBehaviorNone;
    NSRect visibleFrame = NSScreen.mainScreen.visibleFrame;
    check(visibleFrame.size.width >= 500 && visibleFrame.size.height >= 360,
        @"the main screen visible frame can contain the cadence test window");
    if (visibleFrame.size.width < 500 || visibleFrame.size.height < 360) return 1;
    [window setFrameOrigin:NSMakePoint(NSMaxX(visibleFrame) - 520, NSMaxY(visibleFrame) - 380)];
    WKWebView *main = [[[WKWebView alloc] initWithFrame:window.contentView.bounds] autorelease];
    window.contentView = [[[NSView alloc] initWithFrame:window.contentView.bounds] autorelease];
    [window.contentView addSubview:main];
    void *surface = sp_surface_create(main);
    check(surface != NULL, @"the root view fixture has a logical surface");
    if (!surface) { [window close]; return 1; }
    webviewSetFrame(surface, 0, 0, resizeBaseWidth, resizeBaseHeight);
    webviewSetSurfaceHidden(surface, false);

    SPResizeCadenceReceiver *receiver = [[SPResizeCadenceReceiver new] autorelease];
    [[NSNotificationCenter defaultCenter] addObserver:receiver selector:@selector(windowDidChangeOcclusionState:)
        name:NSWindowDidChangeOcclusionStateNotification object:window];
    [window orderFrontRegardless];
    NSString *store = temporaryFolder(@"soksak-resize-cadence-store-");
    void *document = sp_document_create(surface, store.fileSystemRepresentation, "fixture", "fixture", "void 0;", changed, receiver);
    check(document != NULL, [NSString stringWithFormat:@"a plugin root view is created (%s)", sp_document_last_error()]);
    if (!document) {
        [[NSNotificationCenter defaultCenter] removeObserver:receiver name:NSWindowDidChangeOcclusionStateNotification object:window];
        [window orderOut:nil];
        sp_surface_close(surface);
        [window close];
        return 1;
    }
    WKWebView *view = (WKWebView *)document;
    receiver.view = view;
    receiver.surface = surface;
    [view.configuration.userContentController addScriptMessageHandler:receiver name:@"cadence"];
    check(surfaceLayoutPrefersNear60FPS(view) == 0,
        @"the production plugin root view renders at the display rate");
    sp_document_place(document, 0, 0, 0, 0, true);
    NSString *html = @"<!doctype html><html style='height:100%'><body style='margin:0;height:100%'>"
        "<script>const root=document.documentElement;let pending=null;window.cadenceFrames=[];window.cadenceErrors=[];window.cadenceFinalWidth=348;"
        "addEventListener('error',e=>window.cadenceErrors.push(String(e.message||e.error||'unknown script error')));"
        "const observer=new ResizeObserver(entries=>{if(!entries.some(e=>e.target===root))return;"
        "const resizeAtMs=performance.now();if(pending){pending.resizeAtMs=resizeAtMs;pending.resizeCount++;return;}"
        "pending={firstResizeAtMs:resizeAtMs,resizeAtMs,resizeCount:1};const row=pending;"
        "requestAnimationFrame(frameTimeMs=>{if(pending===row)pending=null;"
        "const rect=root.getBoundingClientRect();const result={width:rect.width,height:rect.height,firstResizeAtMs:row.firstResizeAtMs,"
        "resizeAtMs:row.resizeAtMs,resizeCount:row.resizeCount,frameTimeMs,visibility:document.visibilityState};"
        "window.cadenceFrames.push(result);if(!window.cadenceReady){window.cadenceReady=true;"
        "webkit.messageHandlers.cadence.postMessage({ready:true,visibility:result.visibility,width:result.width,height:result.height,"
        "resizeAtMs:result.resizeAtMs,frameTimeMs:result.frameTimeMs});}if(result.width===window.cadenceFinalWidth)"
        "webkit.messageHandlers.cadence.postMessage({done:true});});});"
        "document.addEventListener('visibilitychange',()=>webkit.messageHandlers.cadence.postMessage("
        "{visibility:document.visibilityState}));"
        "requestAnimationFrame(()=>{observer.observe(root,{box:'content-box'});});"
        "</script></body></html>";
    [view loadHTMLString:html baseURL:nil];
    NSDate *loadDeadline = [NSDate dateWithTimeIntervalSinceNow:12];
    while (!([parsedDocumentState(receiver)[@"navigations"] unsignedLongLongValue] > 0
        && ![parsedDocumentState(receiver)[@"loading"] boolValue]) && loadDeadline.timeIntervalSinceNow > 0) {
        pumpOcclusion();
    }
    if (!([parsedDocumentState(receiver)[@"navigations"] unsignedLongLongValue] > 0
        && ![parsedDocumentState(receiver)[@"loading"] boolValue])) {
        check(NO, [NSString stringWithFormat:@"the plugin root test page completes navigation (%@)", stateFor(window, receiver, (NSView *)surface, view)]);
        [view.configuration.userContentController removeScriptMessageHandlerForName:@"cadence"];
        [[NSNotificationCenter defaultCenter] removeObserver:receiver name:NSWindowDidChangeOcclusionStateNotification object:window];
        sp_document_close(document);
        sp_surface_close(surface);
        [window orderOut:nil];
        [window close];
        return failures ? 1 : 0;
    }
    NSDate *readyDeadline = [NSDate dateWithTimeIntervalSinceNow:12];
    while (!receiver.ready && readyDeadline.timeIntervalSinceNow > 0) {
        pumpOcclusion();
    }
    if (!receiver.ready) {
        id diagnostics = evaluate(view, @"JSON.stringify({readyState:document.readyState,href:location.href,"
            "framesType:typeof window.cadenceFrames,frames:window.cadenceFrames,errors:window.cadenceErrors,"
            "handlerType:typeof webkit.messageHandlers.cadence,visibility:document.visibilityState})");
        check(NO, [NSString stringWithFormat:@"the view root receives its observer readiness message (page=%@ native=%@)",
            diagnostics ?: @"evaluation returned nil", stateFor(window, receiver, (NSView *)surface, view)]);
        [view.configuration.userContentController removeScriptMessageHandlerForName:@"cadence"];
        [[NSNotificationCenter defaultCenter] removeObserver:receiver name:NSWindowDidChangeOcclusionStateNotification object:window];
        sp_document_close(document);
        sp_surface_close(surface);
        [window orderOut:nil];
        [window close];
        return failures ? 1 : 0;
    }
    NSDate *visibleDeadline = [NSDate dateWithTimeIntervalSinceNow:12];
    while (!(window.isVisible && window.isOnActiveSpace
        && (window.occlusionState & NSWindowOcclusionStateVisible) != 0
        && [receiver.documentVisibility isEqualToString:@"visible"]
        && !((NSView *)surface).hidden && !view.isHiddenOrHasHiddenAncestor
        && receiver.occlusionNotifications > 0) && visibleDeadline.timeIntervalSinceNow > 0) {
        pumpOcclusion();
    }
    if (!(window.isVisible && window.isOnActiveSpace
        && (window.occlusionState & NSWindowOcclusionStateVisible) != 0
        && [receiver.documentVisibility isEqualToString:@"visible"]
        && receiver.occlusionNotifications > 0)) {
        check(NO, [NSString stringWithFormat:@"the visible inactive fixture reaches its observed window/document state (%@)",
            stateFor(window, receiver, (NSView *)surface, view)]);
        [view.configuration.userContentController removeScriptMessageHandlerForName:@"cadence"];
        [[NSNotificationCenter defaultCenter] removeObserver:receiver name:NSWindowDidChangeOcclusionStateNotification object:window];
        sp_document_close(document);
        sp_surface_close(surface);
        [window orderOut:nil];
        [window close];
        return failures ? 1 : 0;
    }
    runCadenceCase(@"visible-inactive", window, view, receiver);

    [view.configuration.userContentController removeScriptMessageHandlerForName:@"cadence"];
    [[NSNotificationCenter defaultCenter] removeObserver:receiver name:NSWindowDidChangeOcclusionStateNotification object:window];
    sp_document_close(document);
    sp_surface_close(surface);
    [window orderOut:nil];
    [window close];
    check(!NSApp.isActive, @"the resize cadence check does not activate the application");
    return failures ? 1 : 0;
}}
