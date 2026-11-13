// Measures whether the UI process receives the script message that the page sends inside an animation frame before the rendering update of that frame is committed.
// A presentation acknowledgement is registered immediately upon receiving the message. If the acknowledgement arrives before the first screen update (display link) after the message,
// it is attached to the commit of that update; if it arrives after, it is attached to the next update (docs/features.md F92).
// It does not activate the application.
#import <Cocoa/Cocoa.h>
#import <QuartzCore/QuartzCore.h>
#import <WebKit/WebKit.h>
#import "private/webkit.h"
#import "support/event_wait.h"

static int failures;
static void check(BOOL condition, NSString *message) {
    fprintf(condition ? stdout : stderr, "%s: %s\n", condition ? "PASS" : "FAIL", message.UTF8String);
    if (!condition) failures++;
}

// On receiving a "drawn" message, records the receipt time and registers a presentation acknowledgement. When the acknowledgement arrives, records its time
// and asks the page for its next draw, so each draw starts after the acknowledgement of the one before it. The message -1 says that the page has loaded,
// and the first draw starts after the next presentation update after it.
@interface SPDrawnReceiver : NSObject <WKScriptMessageHandler>
@property (nonatomic, assign) WKWebView *webview;
@property (nonatomic, assign) int draws;
@property (nonatomic, retain) NSMutableArray<NSArray<NSNumber *> *> *waits;
@property (nonatomic, retain) NSMutableArray<NSNumber *> *refreshes;
@end
@implementation SPDrawnReceiver
- (void)userContentController:(WKUserContentController *)controller didReceiveScriptMessage:(WKScriptMessage *)message {
    double received = CACurrentMediaTime() * 1000;
    WKWebView *webview = self.webview;
    int draws = self.draws;
    if ([message.body intValue] < 0) {
        [webview _doAfterNextPresentationUpdate:^{ [webview evaluateJavaScript:@"draw()" completionHandler:nil]; }];
        return;
    }
    NSMutableArray<NSArray<NSNumber *> *> *waits = self.waits;
    [webview _doAfterNextPresentationUpdate:^{
        [waits addObject:@[@(received), @(CACurrentMediaTime() * 1000)]];
        if ((int)waits.count < draws) [webview evaluateJavaScript:@"draw()" completionHandler:nil];
    }];
}
// Records the time (ms) of each screen update.
- (void)refresh:(CADisplayLink *)link { [self.refreshes addObject:@(link.timestamp * 1000)]; }
- (void)dealloc { [_waits release]; [_refreshes release]; [super dealloc]; }
@end

int main(void) { @autoreleasepool {
    CFTimeInterval began = CACurrentMediaTime();
    fprintf(stderr, "START: a drawn message reaches the UI process before the commit of its rendering update\n");
    [NSApplication sharedApplication];
    [NSApp setActivationPolicy:NSApplicationActivationPolicyAccessory];
    [NSApp finishLaunching];
    NSWindow *window = [[[NSWindow alloc] initWithContentRect:NSMakeRect(80, 80, 400, 300)
        styleMask:NSWindowStyleMaskBorderless backing:NSBackingStoreBuffered defer:NO] autorelease];
    [window setReleasedWhenClosed:NO];
    window.animationBehavior = NSWindowAnimationBehaviorNone;
    [window orderFrontRegardless];

    static const int draws = 40;
    SPDrawnReceiver *receiver = [[SPDrawnReceiver new] autorelease];
    receiver.waits = [NSMutableArray array];
    receiver.refreshes = [NSMutableArray array];
    WKWebViewConfiguration *configuration = [[WKWebViewConfiguration new] autorelease];
    [configuration.userContentController addScriptMessageHandler:receiver name:@"drawn"];
    WKWebView *webview = [[[WKWebView alloc] initWithFrame:window.contentView.bounds configuration:configuration] autorelease];
    receiver.webview = webview;
    receiver.draws = draws;
    // A window that is not activated is judged occluded and rendering may stop, so the judgment is disabled like the main web view of the application.
    webview._windowOcclusionDetectionEnabled = NO;
    [window.contentView addSubview:webview];
    // Each draw changes the width of the box and sends a message in the same animation frame; the receiver asks for the next draw when the
    // acknowledgement of the previous one arrives.
    NSString *html = @"<!doctype html><body style='margin:0'><div id=box style='height:50px;"
        "width:10px;background:#36c'></div><script>let n=0;function draw(){requestAnimationFrame(()=>{"
        "box.style.width=(10+(n%2)*100)+'px';webkit.messageHandlers.drawn.postMessage(n);n++;})}"
        "addEventListener('load',()=>webkit.messageHandlers.drawn.postMessage(-1))</script>";
    [webview loadHTMLString:html baseURL:nil];
    CADisplayLink *link = [window.contentView displayLinkWithTarget:receiver selector:@selector(refresh:)];
    [link addToRunLoop:NSRunLoop.currentRunLoop forMode:NSRunLoopCommonModes];

    // Each acknowledgement arrives in the completion of a presentation update on the main queue.
    eventWait(@"the presentation of every draw is acknowledged", ^BOOL { return (int)receiver.waits.count >= draws; });
    check((int)receiver.waits.count == draws,
        [NSString stringWithFormat:@"every draw was confirmed (%lu of %d)", (unsigned long)receiver.waits.count, draws]);
    int overlapping = 0;
    for (NSUInteger index = 1; index < receiver.waits.count; index++) {
        if (receiver.waits[index][0].doubleValue < receiver.waits[index - 1][1].doubleValue) overlapping++;
    }
    check(overlapping == 0, [NSString stringWithFormat:@"each draw message arrives after the acknowledgement of the draw before it "
        "(%d of %d arrive before it)", overlapping, draws - 1]);

    [link invalidate];
    // The number of acknowledgements that arrived before the first screen update after the message. That update shows the commit of the frame that sent the message.
    int same = 0;
    NSMutableArray<NSNumber *> *waited = [NSMutableArray array];
    for (NSArray<NSNumber *> *wait in receiver.waits) {
        double received = wait[0].doubleValue, confirmed = wait[1].doubleValue;
        [waited addObject:@(confirmed - received)];
        double next = NAN;
        for (NSNumber *refresh in receiver.refreshes) if (refresh.doubleValue > received) { next = refresh.doubleValue; break; }
        if (!isnan(next) && confirmed < next) same++;
    }
    NSArray<NSNumber *> *sorted = [waited sortedArrayUsingSelector:@selector(compare:)];
    double median = sorted.count ? sorted[sorted.count / 2].doubleValue : NAN;
    fprintf(stdout, "presentation after the drawn message: median %.1fms, min %.1fms, max %.1fms; %d of %lu confirmed before the next "
        "refresh at %ld Hz\n", median, sorted.firstObject.doubleValue, sorted.lastObject.doubleValue, same,
        (unsigned long)sorted.count, (long)window.screen.maximumFramesPerSecond);
    check(!NSApp.isActive, @"the measurement does not activate the application");
    [configuration.userContentController removeScriptMessageHandlerForName:@"drawn"];
    [window close];
    fprintf(stderr, "%s: a drawn message reaches the UI process before the commit of its rendering update (%.1fms)\n",
        failures ? "FAIL" : "PASS", (CACurrentMediaTime() - began) * 1000);
    return failures ? 1 : 0;
}}
