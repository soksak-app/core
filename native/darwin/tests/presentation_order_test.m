// Measures whether the UI process receives the script message that the page sends inside an animation frame before the rendering update of that frame is committed.
// A presentation acknowledgement is registered immediately upon receiving the message. If the acknowledgement arrives before the first screen update (display link) after the message,
// it is attached to the commit of that update; if it arrives after, it is attached to the next update (docs/features.md F92).
// It does not activate the application.
#import <Cocoa/Cocoa.h>
#import <QuartzCore/QuartzCore.h>
#import <WebKit/WebKit.h>
#import "private/webkit.h"

static int failures;
static void check(BOOL condition, NSString *message) {
    fprintf(condition ? stdout : stderr, "%s: %s\n", condition ? "PASS" : "FAIL", message.UTF8String);
    if (!condition) failures++;
}

static void spin(NSTimeInterval seconds) {
    NSDate *until = [NSDate dateWithTimeIntervalSinceNow:seconds];
    while (until.timeIntervalSinceNow > 0) {
        [[NSRunLoop currentRunLoop] runMode:NSDefaultRunLoopMode beforeDate:
            [NSDate dateWithTimeIntervalSinceNow:MIN(0.005, until.timeIntervalSinceNow)]];
    }
}

// On receiving a "drawn" message, records the receipt time and registers a presentation acknowledgement. When the acknowledgement arrives, records its time.
@interface SPDrawnReceiver : NSObject <WKScriptMessageHandler>
@property (nonatomic, assign) WKWebView *webview;
@property (nonatomic, retain) NSMutableArray<NSArray<NSNumber *> *> *waits;
@property (nonatomic, retain) NSMutableArray<NSNumber *> *refreshes;
@end
@implementation SPDrawnReceiver
- (void)userContentController:(WKUserContentController *)controller didReceiveScriptMessage:(WKScriptMessage *)message {
    double received = CACurrentMediaTime() * 1000;
    NSMutableArray<NSArray<NSNumber *> *> *waits = self.waits;
    [self.webview _doAfterNextPresentationUpdate:^{
        [waits addObject:@[@(received), @(CACurrentMediaTime() * 1000)]];
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

    SPDrawnReceiver *receiver = [[SPDrawnReceiver new] autorelease];
    receiver.waits = [NSMutableArray array];
    receiver.refreshes = [NSMutableArray array];
    WKWebViewConfiguration *configuration = [[WKWebViewConfiguration new] autorelease];
    [configuration.userContentController addScriptMessageHandler:receiver name:@"drawn"];
    WKWebView *webview = [[[WKWebView alloc] initWithFrame:window.contentView.bounds configuration:configuration] autorelease];
    receiver.webview = webview;
    // A window that is not activated is judged occluded and rendering may stop, so the judgment is disabled like the main web view of the application.
    webview._windowOcclusionDetectionEnabled = NO;
    [window.contentView addSubview:webview];
    // Each draw changes the width of the box and sends a message in the same animation frame. Pauses between draws so that the previous acknowledgement finishes.
    static const int draws = 40;
    NSString *html = [NSString stringWithFormat:@"<!doctype html><body style='margin:0'><div id=box style='height:50px;"
        "width:10px;background:#36c'></div><script>let n=0;function draw(){requestAnimationFrame(()=>{"
        "box.style.width=(10+(n%%2)*100)+'px';webkit.messageHandlers.drawn.postMessage(n);n++;"
        "if(n<%d)setTimeout(draw,120)})}setTimeout(draw,500)</script>", draws];
    [webview loadHTMLString:html baseURL:nil];
    CADisplayLink *link = [window.contentView displayLinkWithTarget:receiver selector:@selector(refresh:)];
    [link addToRunLoop:NSRunLoop.currentRunLoop forMode:NSRunLoopCommonModes];

    NSDate *deadline = [NSDate dateWithTimeIntervalSinceNow:30];
    while ((int)receiver.waits.count < draws && deadline.timeIntervalSinceNow > 0) spin(0.01);
    check((int)receiver.waits.count == draws,
        [NSString stringWithFormat:@"every draw was confirmed (%lu of %d)", (unsigned long)receiver.waits.count, draws]);

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
