// 표면 좌표계가 1×와 2× 배율, 배율 변경에서 소수점 표면 크기와 마지막 장치 픽셀을 보존하는지,
// 표면 안의 문서 영역이 표면과 같은 배율로 그리는지 검사한다. 연결된 디스플레이와 무관하게 실행되도록 창의 실제 백킹 배율을 바꾼다. WebKit 테스트
// 러너와 같이 AppKit 의 -[NSWindow _setWindowResolution:](비공개, 검사 전용)을 쓰고, 화면이 배율을
// 되돌리지 않게 -_adjustWindowResolution 을 비운다. 이 메서드는 알림과 뷰 콜백을 보내지 않으므로,
// 디스플레이 이동 때 AppKit 이 보내는 창 알림과 viewDidChangeBackingProperties 를 검사가 보낸다.
// docs/operations/private-native-apis.md 참고. 애플리케이션을 활성화하지 않는다.
#import <Cocoa/Cocoa.h>
#import <WebKit/WebKit.h>
#import "document_view.h"
#import "input_inject.h"
#import "private/coregraphics.h"
#import "private/webkit.h"
#import "webview_input.h"
#import "webview_geometry.h"

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
    if (!done()) { fprintf(stderr, "FAIL: WebKit did not answer within 10 seconds\n"); exit(1); }
}

static id evaluate(WKWebView *view, NSString *script) {
    __block BOOL done = NO;
    __block id result = nil;
    [view evaluateJavaScript:script completionHandler:^(id value, NSError *error) {
        if (error) fprintf(stderr, "JavaScript: %s\n", error.localizedDescription.UTF8String);
        result = [value retain];
        done = YES;
    }];
    until(^BOOL { return done; });
    return [result autorelease];
}

@interface NSWindow (SPWindowResolution)
- (void)_setWindowResolution:(CGFloat)resolution;
@end

// 검사 창. 배율은 검사가 정한 값으로만 바뀐다.
@interface SPScaledWindow : NSWindow
@end
@implementation SPScaledWindow
- (void)_adjustWindowResolution {}
@end

static void notifyBackingChange(NSView *view) {
    [view viewDidChangeBackingProperties];
    for (NSView *child in view.subviews) notifyBackingChange(child);
}

static void setScale(SPScaledWindow *window, CGFloat scale) {
    CGFloat old = window.backingScaleFactor;
    [window _setWindowResolution:scale];
    [NSNotificationCenter.defaultCenter postNotificationName:NSWindowDidChangeBackingPropertiesNotification
        object:window userInfo:@{NSBackingPropertyOldScaleFactorKey: @(old)}];
    notifyBackingChange(window.contentView);
}

@interface SPLoaded : NSObject <WKNavigationDelegate>
@property BOOL finished;
@end
@implementation SPLoaded
- (void)webView:(WKWebView *)view didFinishNavigation:(WKNavigation *)navigation { self.finished = YES; }
@end

static void load(WKWebView *view, NSString *html) {
    SPLoaded *loaded = [[SPLoaded new] autorelease];
    view.navigationDelegate = loaded;
    [view loadHTMLString:html baseURL:nil];
    until(^BOOL { return loaded.finished; });
    view.navigationDelegate = nil;
}

// 문서가 새 크기와 배율로 다시 배치될 때까지 기다린다. 끝내 맞지 않으면 마지막 값을 보고한다.
static NSDictionary *documentState(WKWebView *view, CGFloat scale, double width, double height) {
    NSDate *deadline = [NSDate dateWithTimeIntervalSinceNow:10];
    NSDictionary *state = nil;
    for (;;) {
        state = evaluate(view, @"({ratio: devicePixelRatio, width: visualViewport.width,"
            " height: visualViewport.height, body: document.body?.getBoundingClientRect().height})");
        BOOL placed = [state[@"ratio"] doubleValue] == scale && [state[@"width"] doubleValue] == width
            && [state[@"height"] doubleValue] == height;
        if (placed) return state;
        if (deadline.timeIntervalSinceNow <= 0) break;
        [[NSRunLoop currentRunLoop] runMode:NSDefaultRunLoopMode beforeDate:[NSDate dateWithTimeIntervalSinceNow:0.01]];
    }
    fprintf(stderr, "FAIL: the document did not take scale %g and size %g x %g within 10 seconds: %s\n",
        scale, width, height, state.description.UTF8String);
    exit(1);
}

// 스냅샷의 마지막 장치 픽셀 행이 문서의 색인지 확인한다. 문서가 덮지 못한 행은 흰색이다.
static BOOL lastRowIsDocument(WKWebView *view, CGFloat scale) {
    __block NSImage *image = nil;
    WKSnapshotConfiguration *configuration = [[WKSnapshotConfiguration new] autorelease];
    [view takeSnapshotWithConfiguration:configuration completionHandler:^(NSImage *snapshot, NSError *error) {
        image = [snapshot retain];
    }];
    until(^BOOL { return image != nil; });
    NSBitmapImageRep *bitmap = [NSBitmapImageRep imageRepWithData:image.TIFFRepresentation];
    [image release];
    NSInteger rows = bitmap.pixelsHigh;
    NSColor *last = [[bitmap colorAtX:bitmap.pixelsWide / 2 y:rows - 1] colorUsingColorSpace:NSColorSpace.sRGBColorSpace];
    return last.redComponent < 0.2 && last.greenComponent < 0.2 && last.blueComponent < 0.2;
}

// 표면의 마지막 장치 픽셀을 네이티브 입력으로 누르고 문서가 받은 좌표를 반환한다.
static NSDictionary *pressLastPixel(NSWindow *window, WKWebView *surface, CGFloat scale) {
    double frame[4] = {0, 0, 0, 0};
    webviewGetFrame(surface, frame);
    double x = frame[0] + frame[2] / 2, y = frame[1] + frame[3] - 0.5 / scale;
    evaluate(surface, @"window.pressed = null; null");
    check(sp_input_pointer(window, x, y, 1, 0, 0, 0) == SP_INPUT_DELIVERED
        && sp_input_pointer(window, x, y, 3, 0, 0, 0) == SP_INPUT_DELIVERED,
        [NSString stringWithFormat:@"press on the last device pixel delivered at scale %g", scale]);
    __block NSDictionary *pressed = nil;
    until(^BOOL {
        id value = evaluate(surface, @"window.pressed");
        pressed = [value isKindOfClass:NSDictionary.class] ? value : nil;
        return pressed != nil;
    });
    return pressed;
}

static void scrollDone(void *context, sp_input_result result) { *(sp_input_result *)context = result; }

// 앱 이벤트 대기열의 이벤트를 꺼내 처리하며 기다린다. 이벤트 모니터는 꺼낼 때 실행된다.
static void pumpUntil(BOOL (^done)(void)) {
    NSDate *deadline = [NSDate dateWithTimeIntervalSinceNow:10];
    while (!done() && deadline.timeIntervalSinceNow > 0) {
        NSEvent *event = [NSApp nextEventMatchingMask:NSEventMaskAny
            untilDate:[NSDate dateWithTimeIntervalSinceNow:0.01] inMode:NSDefaultRunLoopMode dequeue:YES];
        if (event) [NSApp sendEvent:event];
    }
    if (!done()) { fprintf(stderr, "FAIL: the event was not handled within 10 seconds\n"); exit(1); }
}

// 표면이 스크롤을 마칠 때까지 기다리고 문서가 움직인 CSS 픽셀을 반환한다. 표시마다 두 번 같은 값이면 끝났다.
static double scrolledBy(WKWebView *surface) {
    until(^BOOL { return [evaluate(surface, @"document.scrollingElement.scrollTop") doubleValue] > 0; });
    double last = -1, now = [evaluate(surface, @"document.scrollingElement.scrollTop") doubleValue];
    while (now != last) {
        last = now;
        __block BOOL shown = NO;
        [surface _doAfterNextPresentationUpdate:^{ shown = YES; }];
        until(^BOOL { return shown; });
        now = [evaluate(surface, @"document.scrollingElement.scrollTop") doubleValue];
    }
    return now;
}

// 표면에 네이티브 휠 스크롤을 보내고 문서가 움직인 CSS 픽셀을 반환한다. 휠 이동량은 포인트이고 CSS
// 픽셀 하나는 포인트 하나다. posted 이면 줄 단위 휠 이벤트(3줄, 120 픽셀)를 앱 이벤트 대기열에 넣어
// 실제 이벤트와 같이 앱의 이벤트 모니터를 거치게 한다.
static double scrollBy(NSWindow *window, WKWebView *surface, BOOL posted) {
    evaluate(surface, @"document.scrollingElement.scrollTop = 0; null");
    double frame[4] = {0, 0, 0, 0};
    webviewGetFrame(surface, frame);
    // 문서 영역(위 여백 20)이 생긴 뒤에도 표면이 받도록 위 여백 안의 점을 쓴다.
    double x = frame[0] + frame[2] / 2, y = frame[1] + 10;
    __block BOOL shown = NO;
    [surface _doAfterNextPresentationUpdate:^{ shown = YES; }];
    until(^BOOL { return shown; });
    if (!posted) {
        __block sp_input_result result = SP_INPUT_REJECTED;
        sp_input_pointer_then(window, x, y, 4, 0, 0, 120, 5, scrollDone, &result);
        until(^BOOL { return result != SP_INPUT_REJECTED; });
        check(result == SP_INPUT_DELIVERED, @"a scroll into the surface is delivered");
        return scrolledBy(surface);
    }
    NSView *content = window.contentView;
    NSPoint local = NSMakePoint(x, content.bounds.size.height - y);
    NSPoint inWindow = [content convertPoint:local toView:nil];
    NSPoint screen = [window convertPointToScreen:inWindow];
    CGEventRef wheel = CGEventCreateScrollWheelEvent2(NULL, kCGScrollEventUnitLine, 1, -3, 0, 0);
    CGEventSetLocation(wheel, CGPointMake(screen.x, NSMaxY(NSScreen.screens.firstObject.frame) - screen.y));
    CGEventSetIntegerValueField(wheel, kSPEventWindowNumberField, window.windowNumber);
    CGEventSetWindowLocation(wheel, CGPointMake(inWindow.x, NSHeight(window.frame) - inWindow.y));
    [NSApp postEvent:[NSEvent eventWithCGEvent:wheel] atStart:NO];
    CFRelease(wheel);
    __block double moved = 0;
    pumpUntil(^BOOL { moved = [evaluate(surface, @"document.scrollingElement.scrollTop") doubleValue]; return moved > 0; });
    return scrolledBy(surface);
}

static void verify(SPScaledWindow *window, WKWebView *surface, CGFloat scale, double height, NSString *when) {
    double frame[4] = {0, 0, 0, 0};
    webviewGetFrame(surface, frame);
    check(frame[3] == height,
        [NSString stringWithFormat:@"%@: the native surface keeps the fractional height %g (got %g)", when, height, frame[3]]);
    NSDictionary *state = documentState(surface, scale, frame[2], frame[3]);
    check([state[@"body"] doubleValue] == frame[3],
        [NSString stringWithFormat:@"%@: the document covers the complete native surface (%@)", when, state]);
    check(lastRowIsDocument(surface, scale),
        [NSString stringWithFormat:@"%@: the last device pixel row shows the document", when]);
    double injected = scrollBy(window, surface, NO);
    check(injected == 120,
        [NSString stringWithFormat:@"%@: an injected 120-point scroll moves the document by 120 CSS pixels (%g)", when, injected]);
    double posted = scrollBy(window, surface, YES);
    check(posted == 120,
        [NSString stringWithFormat:@"%@: a three-line scroll from the event queue moves the document by 120 CSS pixels (%g)", when, posted]);
    NSDictionary *pressed = pressLastPixel(window, surface, scale);
    double expected = frame[3] - 0.5 / scale;
    check([pressed[@"trusted"] boolValue] && fabs([pressed[@"y"] doubleValue] - expected) < 0.001,
        [NSString stringWithFormat:@"%@: the document receives input in the last device pixel at %g (%@)", when, expected, pressed]);
}

static void ignoreState(void *context, const char *state) {}

// 표면의 문서 영역이 표면과 같은 배율로 여백 안의 CSS 크기를 갖는지 확인한다.
static void verifyRegion(WKWebView *region, CGFloat scale, double width, double height, NSString *when) {
    NSDictionary *state = documentState(region, scale, width, height);
    check(state != nil, [NSString stringWithFormat:@"%@: the document region renders at scale %g with size %g x %g",
        when, scale, width, height]);
}

int main(void) { @autoreleasepool {
    [NSApplication sharedApplication];
    [NSApp setActivationPolicy:NSApplicationActivationPolicyProhibited];
    [NSApp finishLaunching];
    [NSApp setActivationPolicy:NSApplicationActivationPolicyAccessory];
    SPScaledWindow *window = [[SPScaledWindow alloc] initWithContentRect:NSMakeRect(100, 100, 600, 400)
        styleMask:NSWindowStyleMaskTitled backing:NSBackingStoreBuffered defer:NO];
    [window setReleasedWhenClosed:NO];
    setScale(window, 1);
    WKWebView *main = [[[WKWebView alloc] initWithFrame:NSMakeRect(0, 0, 600, 400)] autorelease];
    window.contentView = [[[NSView alloc] initWithFrame:NSMakeRect(0, 0, 600, 400)] autorelease];
    [window.contentView addSubview:main];
    load(main, @"<!doctype html><body style='margin:0;background:#fff'></body>");
    WKWebView *surface = [[[WKWebView alloc] initWithFrame:NSMakeRect(0, 0, 10, 10)] autorelease];
    [window.contentView addSubview:surface positioned:NSWindowAbove relativeTo:main];
    [window orderBack:nil];
    webviewAttachSurface(surface, main);
    // 앱의 이벤트 모니터(휠 단위 변환)는 웹뷰를 입력에 등록할 때 설치된다.
    webviewInputRegister(surface);
    load(surface, @"<!doctype html><html style='height:100%'><body style='margin:0;height:100%;background:#0d1a14'>"
        "<div style='height:5000px'></div>"
        "<script>addEventListener('pointerup', e => window.pressed = {trusted: e.isTrusted, y: e.clientY}, true)</script>"
        "</body></html>");

    // 2× 에서 반 포인트 높이는 장치 픽셀 경계에 놓인다. 1× 에서는 안쪽 장치 픽셀로 맞춰진다.
    setScale(window, 2);
    webviewSetFrame(surface, 40, 30, 300, 200.5);
    verify(window, surface, 2, 200.5, @"at 2x");
    // 문서 영역은 표면의 하위 뷰다. 여백을 뺀 크기는 300-10-30 × 200.5-20-40 이다.
    WKWebView *region = (WKWebView *)sp_document_create(surface, "soksak-test/geometry", ignoreState, NULL);
    check(region != NULL, @"a document region is created in the surface");
    sp_document_place(region, 10, 20, 30, 40, true);
    verifyRegion(region, 2, 260, 140.5, @"at 2x");

    setScale(window, 1);
    webviewSetFrame(surface, 40, 30, 300, 200.5);
    verify(window, surface, 1, 200, @"after changing to 1x");
    verifyRegion(region, 1, 260, 140, @"after changing to 1x");

    setScale(window, 2);
    webviewSetFrame(surface, 40, 30, 300, 200.5);
    verify(window, surface, 2, 200.5, @"after changing back to 2x");
    verifyRegion(region, 2, 260, 140.5, @"after changing back to 2x");
    sp_document_close(region);

    [window close];
    [window release];
    return failures ? 1 : 0;
}}
