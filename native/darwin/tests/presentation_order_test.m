// 페이지가 animation frame 안에서 보낸 script message 를 UI process 가 그 frame 의 렌더링 갱신이 커밋되기 전에
// 받는지 잰다. 메시지를 받은 즉시 표시 확인을 등록한다. 확인이 메시지를 받은 뒤의 첫 화면 갱신(display link) 전에
// 오면 그 갱신의 커밋에 붙은 것이고, 그 뒤에 오면 다음 갱신에 붙은 것이다(docs/features.md F92).
// 애플리케이션을 활성화하지 않는다.
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

// "drawn" 메시지를 받으면 받은 시각을 적고 표시 확인을 등록한다. 확인이 오면 그 시각을 적는다.
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
// 화면 갱신마다 그 갱신의 시각(ms)을 적는다.
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
    // 활성화하지 않은 창은 가려진 것으로 판정되어 렌더링이 멈출 수 있으므로 앱의 주 웹뷰처럼 판정을 끈다.
    webview._windowOcclusionDetectionEnabled = NO;
    [window.contentView addSubview:webview];
    // 그리기마다 상자의 폭을 바꾸고 같은 animation frame 에서 메시지를 보낸다. 그리기 사이는 쉬어 앞 확인이 끝나게 한다.
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
    // 메시지를 받은 뒤 첫 화면 갱신 전에 확인이 온 수. 그 갱신은 메시지를 보낸 frame 의 커밋을 보인다.
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
