// 표면 웹뷰의 웹 인스펙터를 열어도 표면이 호스트가 정한 자리에 남는지 검사한다. 인스펙터를 창에
// 붙이면 WebKit 이 검사 대상 뷰를 창의 남은 자리로 옮기고, 인스펙터를 닫아도 되돌리지 않는다.
// 표면의 자리는 페이지가 정하므로 그 이동은 화면을 깨뜨린다.
//
// 인스펙터는 WKWebView 의 비공개 항목 `_inspector` 로 연다(검사 전용,
// docs/operations/private-native-apis.md 참고). 인스펙터 창이 열리므로 애플리케이션을 활성화한다.
#import <Cocoa/Cocoa.h>
#import <WebKit/WebKit.h>
#import "webview_geometry.h"

@protocol SPInspector <NSObject>
- (void)connect;
- (void)show;
- (void)attach;
- (void)close;
@property (nonatomic, readonly, getter=isVisible) BOOL visible;
@property (nonatomic, readonly, getter=isConnected) BOOL connected;
@property (nonatomic, readonly) WKWebView *inspectorWebView;
@end

@interface WKWebView (SPInspector)
@property (nonatomic, readonly) id<SPInspector> _inspector;
@end

static int failures = 0;

static void check(BOOL condition, NSString *message) {
    fprintf(condition ? stdout : stderr, "%s: %s\n", condition ? "PASS" : "FAIL", message.UTF8String);
    if (!condition) failures++;
}

static void until(BOOL (^done)(void)) {
    NSDate *deadline = [NSDate dateWithTimeIntervalSinceNow:10];
    while (!done() && deadline.timeIntervalSinceNow > 0) {
        [[NSRunLoop currentRunLoop] runMode:NSDefaultRunLoopMode beforeDate:[NSDate dateWithTimeIntervalSinceNow:0.01]];
    }
}

// 창 좌표의 표면 프레임.
static NSRect frameOf(WKWebView *view) {
    double rect[4] = {0, 0, 0, 0};
    webviewGetFrame(view, rect);
    return NSMakeRect(rect[0], rect[1], rect[2], rect[3]);
}

static NSString *describe(NSRect rect) {
    return [NSString stringWithFormat:@"%.0f,%.0f %.0fx%.0f", rect.origin.x, rect.origin.y, rect.size.width, rect.size.height];
}

int main(void) { @autoreleasepool {
    [NSApplication sharedApplication];
    [NSApp setActivationPolicy:NSApplicationActivationPolicyRegular];
    [NSApp finishLaunching];
    NSWindow *window = [[NSWindow alloc] initWithContentRect:NSMakeRect(200, 200, 1000, 700)
        styleMask:NSWindowStyleMaskTitled | NSWindowStyleMaskResizable
        backing:NSBackingStoreBuffered defer:NO];
    [window setReleasedWhenClosed:NO];
    // 인스펙터는 개발자 도구를 켠 페이지에서만 열린다. 애플리케이션의 디버그 빌드도 이 값을 켠다.
    WKWebViewConfiguration *configuration = [[WKWebViewConfiguration new] autorelease];
    [configuration.preferences setValue:@YES forKey:@"developerExtrasEnabled"];
    WKWebView *main = [[[WKWebView alloc] initWithFrame:window.contentView.bounds
        configuration:configuration] autorelease];
    [window.contentView addSubview:main];
    WKWebView *surface = [[[WKWebView alloc] initWithFrame:NSMakeRect(0, 0, 400, 300)
        configuration:[[configuration copy] autorelease]] autorelease];
    [window.contentView addSubview:surface];
    [main loadHTMLString:@"<body style='margin:0'>main</body>" baseURL:nil];
    [surface loadHTMLString:@"<body style='margin:0'>surface</body>" baseURL:nil];
    [window makeKeyAndOrderFront:nil];
    until(^BOOL { return !main.loading && !surface.loading; });
    webviewAttachSurface(surface, main);
    webviewSetFrame(surface, 100, 50, 400, 300);
    NSRect placed = frameOf(surface);
    check(NSEqualRects(placed, NSMakeRect(100, 50, 400, 300)),
        [NSString stringWithFormat:@"the surface starts at its place (%@)", describe(placed)]);

    surface.inspectable = YES;
    id<SPInspector> inspector = surface._inspector;
    check(inspector != nil, @"the surface webview has an inspector");
    [NSApp activateIgnoringOtherApps:YES];
    [inspector connect];
    until(^BOOL { return inspector.connected; });
    [inspector show];
    until(^BOOL { return inspector.visible; });
    check(inspector.visible, @"the inspector opens");

    // 인스펙터를 창에 붙인다. 사용자가 인스펙터의 도킹 단추로 하는 동작이다.
    [inspector attach];
    until(^BOOL { return inspector.inspectorWebView.window == window; });
    check(inspector.inspectorWebView.window == window, @"the inspector attaches to the window");
    NSRect attached = frameOf(surface);
    check(NSEqualRects(attached, placed),
        [NSString stringWithFormat:@"the attached inspector leaves the surface at its place (%@)", describe(attached)]);

    [inspector close];
    until(^BOOL { return !inspector.visible; });
    NSRect closed = frameOf(surface);
    check(NSEqualRects(closed, placed),
        [NSString stringWithFormat:@"closing the inspector leaves the surface at its place (%@)", describe(closed)]);
    [window close];
    [window release];
    return failures ? 1 : 0;
}}
