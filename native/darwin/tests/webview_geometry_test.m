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

// 실패 시 원인을 좁히도록 검사 창의 표시 상태를 기록한다.
static NSWindow *testWindow = nil;
static const char *currentStep = "setup";

static void failTimeout(const char *reason) {
    fprintf(stderr, "FAIL: %s within 10 seconds (step: %s, visible: %d, occlusion visible: %d, on active space: %d, "
        "app active: %d, physical buttons: %lu)\n", reason, currentStep, testWindow.isVisible,
        (testWindow.occlusionState & NSWindowOcclusionStateVisible) != 0, testWindow.isOnActiveSpace,
        NSApp.isActive, (unsigned long)NSEvent.pressedMouseButtons);
    exit(1);
}

static void until(BOOL (^done)(void)) {
    NSDate *deadline = [NSDate dateWithTimeIntervalSinceNow:10];
    while (!done() && deadline.timeIntervalSinceNow > 0) {
        [[NSRunLoop currentRunLoop] runMode:NSDefaultRunLoopMode beforeDate:[NSDate dateWithTimeIntervalSinceNow:0.01]];
    }
    if (!done()) failTimeout("WebKit did not answer");
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
    currentStep = __func__;
    SPLoaded *loaded = [[SPLoaded new] autorelease];
    view.navigationDelegate = loaded;
    [view loadHTMLString:html baseURL:nil];
    until(^BOOL { return loaded.finished; });
    view.navigationDelegate = nil;
}

// 문서가 새 크기와 배율로 다시 배치될 때까지 기다린다. 끝내 맞지 않으면 마지막 값을 보고한다.
static NSDictionary *documentState(WKWebView *view, CGFloat scale, double width, double height) {
    currentStep = __func__;
    // WebKit exposes the CSS viewport on whole CSS pixels. A 200.5pt AppKit
    // frame therefore reports 200 CSS px even though its native backing is
    // 401px at 2x. Native geometry and the final backing row are checked
    // separately and remain exact.
    double cssHeight = floor(height);
    NSDate *deadline = [NSDate dateWithTimeIntervalSinceNow:10];
    NSDictionary *state = nil;
    for (;;) {
        state = evaluate(view, @"({ratio: devicePixelRatio, width: visualViewport.width,"
            " height: visualViewport.height, body: document.body?.getBoundingClientRect().height})");
        BOOL placed = [state[@"ratio"] doubleValue] == scale && [state[@"width"] doubleValue] == width
            && [state[@"height"] doubleValue] == cssHeight;
        if (placed) return state;
        if (deadline.timeIntervalSinceNow <= 0) break;
        [[NSRunLoop currentRunLoop] runMode:NSDefaultRunLoopMode beforeDate:[NSDate dateWithTimeIntervalSinceNow:0.01]];
    }
    fprintf(stderr, "FAIL: the document did not take scale %g and CSS size %g x %g within 10 seconds: %s\n",
        scale, width, cssHeight, state.description.UTF8String);
    exit(1);
}

// 스냅샷의 마지막 장치 픽셀 행이 문서의 색인지 확인한다. 문서가 덮지 못한 행은 흰색이다.
static BOOL lastRowIsDocument(WKWebView *view, CGFloat scale) {
    currentStep = __func__;
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
    currentStep = __func__;
    double frame[4] = {0, 0, 0, 0};
    webviewGetFrame(surface, frame);
    double x = frame[0] + frame[2] / 2, y = frame[1] + frame[3] - 0.5 / scale;
    NSView *content = window.contentView;
    NSPoint local = NSMakePoint(x, content.bounds.size.height - y);
    NSPoint inWindow = [content convertPoint:local toView:nil];
    NSView *hit = [content hitTest:[content convertPoint:inWindow fromView:nil]];
    BOOL surfaceHit = NO;
    for (NSView *view = hit; view; view = view.superview) if (view == surface) surfaceHit = YES;
    check(surfaceHit, [NSString stringWithFormat:@"the last surface pixel resolves to the DOM plane (hit %@)",
        NSStringFromClass(hit.class)]);
    evaluate(surface, @"window.pressed = null; null");
    // 결과 코드와 실제 마우스 버튼 상태를 보고한다. 실제 버튼이 눌린 동안 합성 누름은 전달되지 않는다
    // (SP_INPUT_BUTTON_HELD). 전달되지 않은 누름은 문서가 받을 수 없으므로 기다리지 않고 실패한다.
    NSUInteger buttons = NSEvent.pressedMouseButtons;
    sp_input_result down = sp_input_pointer(window, x, y, 1, 0, 0, 0);
    sp_input_result up = sp_input_pointer(window, x, y, 3, 0, 0, 0);
    BOOL delivered = down == SP_INPUT_DELIVERED && up == SP_INPUT_DELIVERED;
    check(delivered, [NSString stringWithFormat:@"press on the last device pixel delivered at scale %g "
        "(down %d, up %d; physical buttons before %lu, after %lu)", scale, down, up,
        (unsigned long)buttons, (unsigned long)NSEvent.pressedMouseButtons]);
    if (!delivered) {
        fprintf(stderr, "FAIL: the press was not delivered (step: %s)\n", currentStep);
        exit(1);
    }
    __block NSDictionary *pressed = nil;
    until(^BOOL {
        id value = evaluate(surface, @"window.pressed");
        pressed = [value isKindOfClass:NSDictionary.class] ? value : nil;
        return pressed != nil;
    });
    return pressed;
}

static void scrollDone(void *context, sp_input_result result) { *(sp_input_result *)context = result; }

static WKWebView *webViewAtTopPoint(NSWindow *window, double x, double y) {
    NSView *content = window.contentView;
    NSPoint local = NSMakePoint(x, content.bounds.size.height - y);
    NSPoint inWindow = [content convertPoint:local toView:nil];
    NSView *target = [content hitTest:[content convertPoint:inWindow fromView:nil]];
    while (target && ![target isKindOfClass:WKWebView.class]) target = target.superview;
    return (WKWebView *)target;
}

// 앱 이벤트 대기열의 이벤트를 꺼내 처리하며 기다린다. 이벤트 모니터는 꺼낼 때 실행된다.
// 이 검사가 대기열에 넣은 휠 이벤트만 꺼내 보낸다. 모든 종류를 꺼내면 OS 가 보낸 앱 활성화
// 이벤트(NSEventTypeAppKitDefined, 활성화 하위 종류)도 처리해 기본 검사가 앱을 활성화한다.
// 실패하면 꺼내 보낸 휠 이벤트 수, 시작할 때의 실제 마우스 버튼, state 가 돌려준 측정값을 보고한다.
static void pumpUntil(BOOL (^done)(void), NSString *(^state)(void)) {
    NSUInteger buttons = NSEvent.pressedMouseButtons;
    NSUInteger sent = 0;
    NSMutableArray *seen = [NSMutableArray array];
    NSDate *deadline = [NSDate dateWithTimeIntervalSinceNow:10];
    while (!done() && deadline.timeIntervalSinceNow > 0) {
        NSEvent *event = [NSApp nextEventMatchingMask:NSEventMaskScrollWheel
            untilDate:[NSDate dateWithTimeIntervalSinceNow:0.01] inMode:NSDefaultRunLoopMode dequeue:YES];
        if (event) {
            sent++;
            NSView *content = event.window.contentView;
            NSView *hit = [content hitTest:[content.superview convertPoint:event.locationInWindow fromView:nil]];
            [seen addObject:[NSString stringWithFormat:@"{delta %g,%g modifiers 0x%lx physical modifiers 0x%llx precise %d phase %lu momentum %lu window %d at %@ hit %@}",
                event.scrollingDeltaX, event.scrollingDeltaY, (unsigned long)event.modifierFlags,
                (unsigned long long)CGEventSourceFlagsState(kCGEventSourceStateHIDSystemState), event.hasPreciseScrollingDeltas,
                (unsigned long)event.phase, (unsigned long)event.momentumPhase, event.window == testWindow,
                NSStringFromPoint(event.locationInWindow), hit.class]];
            [NSApp sendEvent:event];
        }
    }
    if (!done()) {
        fprintf(stderr, "wheel events dequeued and sent: %lu %s; physical buttons at start: %lu; %s\n",
            (unsigned long)sent, [seen componentsJoinedByString:@" "].UTF8String, (unsigned long)buttons, state().UTF8String);
        failTimeout("the event was not handled");
    }
}

// 표면이 스크롤을 마칠 때까지 기다리고 문서가 움직인 CSS 픽셀을 반환한다. 표시마다 두 번 같은 값이면 끝났다.
// 마지막 스크롤 측정의 표시별 값과 경과 시간. 실패 메시지가 이 값을 보고한다.
static NSMutableString *scrollSamples = nil;

static double scrolledBy(WKWebView *surface) {
    currentStep = __func__;
    NSDate *start = [NSDate date];
    [scrollSamples release];
    scrollSamples = [[NSMutableString alloc] init];
    until(^BOOL { return [evaluate(surface, @"document.scrollingElement.scrollTop") doubleValue] > 0; });
    double last = -1, now = [evaluate(surface, @"document.scrollingElement.scrollTop") doubleValue];
    [scrollSamples appendFormat:@"%g@%.0fms", now, -start.timeIntervalSinceNow * 1000];
    while (now != last) {
        last = now;
        __block BOOL shown = NO;
        [surface _doAfterNextPresentationUpdate:^{ shown = YES; }];
        until(^BOOL { return shown; });
        now = [evaluate(surface, @"document.scrollingElement.scrollTop") doubleValue];
        [scrollSamples appendFormat:@" %g@%.0fms", now, -start.timeIntervalSinceNow * 1000];
    }
    return now;
}

// 표면에 네이티브 휠 스크롤을 보내고 문서가 움직인 CSS 픽셀을 반환한다. 휠 이동량은 포인트이고 CSS
// 픽셀 하나는 포인트 하나다. posted 이면 줄 단위 휠 이벤트(3줄, 120 픽셀)를 앱 이벤트 대기열에 넣어
// 실제 이벤트와 같이 앱의 이벤트 모니터를 거치게 한다.
static double scrollBy(NSWindow *window, WKWebView *surface, BOOL posted) {
    currentStep = __func__;
    evaluate(surface, @"document.scrollingElement.scrollTop = 0; null");
    double frame[4] = {0, 0, 0, 0};
    webviewGetFrame(surface, frame);
    // 문서 영역(위 여백 20)이 생긴 뒤에도 표면이 받도록 위 여백 안의 점을 쓴다.
    double x = frame[0] + frame[2] / 2, y = frame[1] + 10;
    NSView *contentForHit = window.contentView;
    NSPoint localForHit = NSMakePoint(x, contentForHit.bounds.size.height - y);
    NSPoint windowPointForHit = [contentForHit convertPoint:localForHit toView:nil];
    NSView *target = [contentForHit hitTest:[contentForHit convertPoint:windowPointForHit fromView:nil]];
    while (target && ![target isKindOfClass:WKWebView.class]) target = target.superview;
    NSView *hostForHit = surface.superview;
    BOOL insideHost = NO;
    for (NSView *view = target; view; view = view.superview) if (view == hostForHit) insideHost = YES;
    NSRect targetInHost = target ? [target convertRect:target.bounds toView:hostForHit] : NSZeroRect;
    check(target == surface, [NSString stringWithFormat:
        @"scroll target is the surface DOM plane (got %@ inside host %d, target frame %@, host frame %@)",
        target, insideHost, NSStringFromRect(targetInHost), NSStringFromRect(hostForHit.frame)]);
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
    // 실패 보고가 문서까지 온 휠 이벤트 수를 적도록 센다.
    // 실패 보고가 문서까지 온 휠 이벤트 수와 기다리는 동안 돈 애니메이션 프레임 수를 적도록 센다.
    evaluate(surface, @"window.wheels = 0; window.animationFrames = 0; if (!window.wheelCounted) { window.wheelCounted = true;"
        " addEventListener('wheel', () => { window.wheels++; }, {passive: true});"
        " const tick = () => { window.animationFrames++; requestAnimationFrame(tick); }; requestAnimationFrame(tick); } null");
    CGEventRef wheel = CGEventCreateScrollWheelEvent2(NULL, kCGScrollEventUnitLine, 1, -3, 0, 0);
    // 원본이 없는 이벤트는 실제 키보드의 수정키를 물려받는다. AppKit 은 Shift 가 눌린 마우스 휠의 세로 이동을
    // 가로로 바꾸므로, 사람이 Shift 를 누른 동안 이 스크롤은 문서를 움직이지 않았다(V5-25-1).
    CGEventSetFlags(wheel, 0);
    CGEventSetLocation(wheel, CGPointMake(screen.x, NSMaxY(NSScreen.screens.firstObject.frame) - screen.y));
    CGEventSetIntegerValueField(wheel, kSPEventWindowNumberField, window.windowNumber);
    CGEventSetWindowLocation(wheel, CGPointMake(inWindow.x, NSHeight(window.frame) - inWindow.y));
    [NSApp postEvent:[NSEvent eventWithCGEvent:wheel] atStart:NO];
    CFRelease(wheel);
    __block double moved = 0;
    pumpUntil(^BOOL { moved = [evaluate(surface, @"document.scrollingElement.scrollTop") doubleValue]; return moved > 0; },
        ^NSString *{ return [NSString stringWithFormat:@"last scrollTop: %g; document state: %@; scale %g; surface frame %@",
            moved, evaluate(surface, @"JSON.stringify({wheels: window.wheels, animationFrames: window.animationFrames,"
                " visibility: document.visibilityState, scrollHeight: document.scrollingElement.scrollHeight,"
                " clientHeight: document.scrollingElement.clientHeight, scrollTop: document.scrollingElement.scrollTop})"),
            window.backingScaleFactor, NSStringFromRect(surface.frame)]; });
    return scrolledBy(surface);
}

static void verify(SPScaledWindow *window, WKWebView *surface, CGFloat scale, double height, NSString *when) {
    double frame[4] = {0, 0, 0, 0};
    webviewGetFrame(surface, frame);
    check(frame[3] == height,
        [NSString stringWithFormat:@"%@: the native surface keeps the fractional height %g (got %g)", when, height, frame[3]]);
    NSDictionary *state = documentState(surface, scale, frame[2], frame[3]);
    double cssHeight = floor(frame[3]);
    check([state[@"body"] doubleValue] == cssHeight,
        [NSString stringWithFormat:@"%@: the document covers the CSS viewport quantized from native height %g (%@)", when, frame[3], state]);
    check(lastRowIsDocument(surface, scale),
        [NSString stringWithFormat:@"%@: the last device pixel row shows the document", when]);
    double injected = scrollBy(window, surface, NO);
    check(injected == 120,
        [NSString stringWithFormat:@"%@: an injected 120-point scroll moves the document by 120 CSS pixels (%g; samples %@; app active %d)", when, injected, scrollSamples, NSApp.isActive]);
    double posted = scrollBy(window, surface, YES);
    check(posted == 120,
        [NSString stringWithFormat:@"%@: a three-line scroll from the event queue moves the document by 120 CSS pixels (%g; samples %@; app active %d)", when, posted, scrollSamples, NSApp.isActive]);
    NSDictionary *pressed = pressLastPixel(window, surface, scale);
    double expected = frame[3] - 0.5 / scale;
    check([pressed[@"trusted"] boolValue] && fabs([pressed[@"y"] doubleValue] - expected) < 0.001,
        [NSString stringWithFormat:@"%@: the document receives input in the last device pixel at %g (%@)", when, expected, pressed]);
}

static void ignoreState(void *context, const char *state) {}

// 표면의 문서 영역이 표면과 같은 배율로 여백 안의 CSS 크기를 갖는지 확인한다.
static void verifyRegion(WKWebView *region, CGFloat scale, double width, double height, NSString *when) {
    currentStep = __func__;
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
    testWindow = window;
    setScale(window, 1);
    WKWebView *main = [[[WKWebView alloc] initWithFrame:NSMakeRect(0, 0, 600, 400)] autorelease];
    window.contentView = [[[NSView alloc] initWithFrame:NSMakeRect(0, 0, 600, 400)] autorelease];
    [window.contentView addSubview:main];
    load(main, @"<!doctype html><body style='margin:0;background:#fff'></body>");
    WKWebView *surface = [[[WKWebView alloc] initWithFrame:NSMakeRect(0, 0, 10, 10)] autorelease];
    [window.contentView addSubview:surface positioned:NSWindowAbove relativeTo:main];
    [window orderBack:nil];
    // 창은 포커스를 가져가지 않도록 뒤에 있으므로 다른 창에 가려질 수 있다. 실패를 해석하도록 시작 상태를 적는다.
    fprintf(stdout, "INFO: window occlusion visible at start: %d\n",
        (window.occlusionState & NSWindowOcclusionStateVisible) != 0);
    check(sp_surface_create(main) != NULL,
        @"the main webview creates the composition before a surface webview is attached");
    webviewAttachSurface(surface, main);
    check(main.superview == surface.superview.superview.superview,
        @"the attached surface webview uses the main webview's canonical composition");
    check(surface.underPageBackgroundColor.alphaComponent == 0
        && ![[surface valueForKey:@"drawsBackground"] boolValue],
        @"an attached surface webview does not paint an opaque backing over native regions");
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
    double overlay[5] = {50, 50, 50, 50, 1};
    webviewSetSurfaceOverlays(surface, overlay, 1);
    check(webViewAtTopPoint(window, 190, 130) == surface,
        @"a declared DOM overlay receives input above a native document region");
    check(webViewAtTopPoint(window, 60, 60) == region,
        @"the native document receives input outside the declared DOM overlay");
    webviewSetSurfaceOverlays(surface, NULL, 0);

    setScale(window, 1);
    webviewSetFrame(surface, 40, 30, 300, 200.5);
    verify(window, surface, 1, 200.5, @"after changing to 1x");
    verifyRegion(region, 1, 260, 140.5, @"after changing to 1x");

    setScale(window, 2);
    webviewSetFrame(surface, 40, 30, 300, 200.5);
    verify(window, surface, 2, 200.5, @"after changing back to 2x");
    verifyRegion(region, 2, 260, 140.5, @"after changing back to 2x");
    sp_document_close(region);

    [window close];
    [window release];
    return failures ? 1 : 0;
}}
