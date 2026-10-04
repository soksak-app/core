#import <Cocoa/Cocoa.h>
#import <objc/runtime.h>
#import "webview_input.h"
#import "application_log.h"
// _setIgnoresMouseMoveEvents: 는 키보드, 클릭, 드래그를 끄지 않고 pointer tracking 만
// 제어한다. 그 이벤트를 받는 webview 는 AppKit 의 hit test 가 선택한다.
#import "private/webkit.h"
#import "webview_geometry.h"
#import "window_objects.h"

static NSHashTable *inputViews;
static NSMapTable<NSWindow *, WKWebView *> *lastPointerTargets;

// 추적을 켠 바로 그 이동은 WebKit의 추적 소유자에게 도달하지 않을 수 있다.
// 새 대상의 첫 이동을 전달해 페이지가 현재 위치의 커서를 계산하게 한다.
static void refreshPointerCursor(WKWebView *view, NSEvent *event) {
    if (NSEvent.pressedMouseButtons != 0) return;
    [view updateTrackingAreas];
    for (NSTrackingArea *area in view.trackingAreas) {
        if ((area.options & NSTrackingMouseMoved) && [area.owner respondsToSelector:@selector(mouseMoved:)]) {
            [area.owner mouseMoved:event];
            return;
        }
    }
}

// 문서가 받은 신뢰 포인터 이벤트를 알리는 스크립트. 페이지와 분리된 content world 에서 실행한다.
static NSString *const kReceiptWorld = @"soksak-input";
static NSString *const kReceiptMessage = @"soksakInputReceipt";
static NSString *const kReceiptScript =
    @"for (const type of ['pointerdown', 'pointerup', 'click']) addEventListener(type, (event) => {"
    " if (event.isTrusted) webkit.messageHandlers.soksakInputReceipt.postMessage(type); }, true);";

@interface SPInputWait : NSObject
@property(nonatomic, copy) NSString *type;
@property(nonatomic, copy) void (^done)(BOOL);
@end
@implementation SPInputWait
- (void)dealloc { [_type release]; [_done release]; [super dealloc]; }
@end

// 한 웹뷰의 수신 대기. 사용자 콘텐츠 컨트롤러가 이 객체를 보유한다.
@interface SPInputReceipts : NSObject <WKScriptMessageHandler>
@property(nonatomic, retain) NSMutableArray<SPInputWait *> *waits;
@end
@implementation SPInputReceipts
- (void)dealloc { [_waits release]; [super dealloc]; }
- (void)userContentController:(WKUserContentController *)controller didReceiveScriptMessage:(WKScriptMessage *)message {
    if (!message.frameInfo.isMainFrame || ![message.body isKindOfClass:NSString.class]) return;
    for (SPInputWait *wait in self.waits) {
        if (![wait.type isEqualToString:message.body]) continue;
        [[wait retain] autorelease];
        [self.waits removeObject:wait];
        wait.done(YES);
        return;
    }
}
@end

// 한 웹뷰의 입력 등록. 웹뷰의 연결 객체이므로 웹뷰와 함께 해제된다. WebKit 의 사용자 콘텐츠 컨트롤러는 메시지
// 처리기를 등록한 동안 자기 자신을 보유하므로, 처리기를 제거하지 않으면 웹뷰가 해제된 뒤에도 컨트롤러와 그
// 컨트롤러에 등록된 다른 처리기가 남는다. 이 객체는 등록 해제나 웹뷰 해제 때 처리기를 제거한다.
@interface SPInputRegistration : NSObject
@property(nonatomic, retain) WKUserContentController *controller;
@property(nonatomic, retain) SPInputReceipts *receipts;
- (void)end;
@end
@implementation SPInputRegistration
- (instancetype)init {
    if (!(self = [super init])) return nil;
    sp_window_object_change(SP_WINDOW_OBJECT_INPUT_REGISTRATION, 1);
    return self;
}
- (void)end {
    if (!self.controller) return;
    [self.controller removeScriptMessageHandlerForName:kReceiptMessage contentWorld:[WKContentWorld worldWithName:kReceiptWorld]];
    self.controller = nil;
    NSArray *waits = [[self.receipts.waits copy] autorelease];
    [self.receipts.waits removeAllObjects];
    for (SPInputWait *wait in waits) wait.done(NO);
}
- (void)dealloc {
    sp_window_object_change(SP_WINDOW_OBJECT_INPUT_REGISTRATION, -1);
    [self end];
    [_receipts release];
    [super dealloc];
}
@end

static const char registrationKey;

static SPInputReceipts *receiptsFor(WKWebView *view) {
    SPInputRegistration *registration = objc_getAssociatedObject(view, &registrationKey);
    return registration.receipts;
}

static BOOL hasPendingMouseDrain(WKWebView *view) {
    if ([view respondsToSelector:@selector(_doAfterProcessingAllPendingMouseEvents:)]) return YES;
    sp_log_error("webview input", "_doAfterProcessingAllPendingMouseEvents: is unavailable");
    return NO;
}

static void installReceipts(WKWebView *view) {
    if (objc_getAssociatedObject(view, &registrationKey)) return;
    SPInputReceipts *handler = [[SPInputReceipts new] autorelease];
    handler.waits = [NSMutableArray array];
    WKContentWorld *world = [WKContentWorld worldWithName:kReceiptWorld];
    WKUserContentController *controller = view.configuration.userContentController;
    [controller addScriptMessageHandler:handler contentWorld:world name:kReceiptMessage];
    [controller addUserScript:[[[WKUserScript alloc] initWithSource:kReceiptScript
        injectionTime:WKUserScriptInjectionTimeAtDocumentStart forMainFrameOnly:YES inContentWorld:world] autorelease]];
    // 이미 읽은 문서에는 사용자 스크립트가 적용되지 않으므로 같은 world 에서 한 번 실행한다.
    if (view.URL) [view evaluateJavaScript:kReceiptScript inFrame:nil inContentWorld:world completionHandler:nil];
    SPInputRegistration *registration = [[SPInputRegistration new] autorelease];
    registration.controller = controller;
    registration.receipts = handler;
    objc_setAssociatedObject(view, &registrationKey, registration, OBJC_ASSOCIATION_RETAIN_NONATOMIC);
}

void webviewInputReceive(WKWebView *view, NSString *type, NSTimeInterval timeout, void (^done)(BOOL received)) {
    NSCAssert(NSThread.isMainThread, @"Webview input receipts require the main thread");
    SPInputReceipts *handler = receiptsFor(view);
    if (!handler) { done(YES); return; }
    SPInputWait *wait = [[SPInputWait new] autorelease];
    wait.type = type;
    wait.done = done;
    [handler.waits addObject:wait];
    dispatch_after(dispatch_time(DISPATCH_TIME_NOW, (int64_t)(timeout * NSEC_PER_SEC)), dispatch_get_main_queue(), ^{
        if (![handler.waits containsObject:wait]) return;
        [[wait retain] autorelease];
        [handler.waits removeObject:wait];
        wait.done(NO);
    });
}

void webviewInputSendThen(WKWebView *view, NSString *type, NSTimeInterval timeout,
    BOOL (^send)(void), void (^done)(BOOL received)) {
    NSCAssert(NSThread.isMainThread, @"Webview input receipts require the main thread");
    SPInputReceipts *handler = receiptsFor(view);
    if (!handler) {
        done(send());
        return;
    }
    if (!hasPendingMouseDrain(view)) { done(NO); return; }
    SPInputWait *wait = [[SPInputWait new] autorelease];
    wait.type = type;
    wait.done = ^(BOOL received) {
        if (!received || !hasPendingMouseDrain(view)) {
            done(NO);
            return;
        }
        [view _doAfterProcessingAllPendingMouseEvents:^{ done(YES); }];
    };
    [handler.waits addObject:wait];
    dispatch_after(dispatch_time(DISPATCH_TIME_NOW, (int64_t)(timeout * NSEC_PER_SEC)), dispatch_get_main_queue(), ^{
        if (![handler.waits containsObject:wait]) return;
        [[wait retain] autorelease];
        [handler.waits removeObject:wait];
        wait.done(NO);
    });
    // 터미널 입력 뒤에는 네이티브 그림 영역이 첫 응답자일 수 있다. 이 상태에서 창이
    // 비활성화되어 있으면 WebKit이 대상 페이지를 마우스 처리 경로에서 제외할 수 있어
    // drain 콜백이 다음 합성 포인터까지 도달하지 않는다. WebKit의 대기 중인 마우스
    // 작업을 기다리기 전에 대상 웹뷰를 응답자로 복원한다. 페이지에는 아래에서 보내는
    // 포인터 하나만 전달하며, 네이티브 그림 영역 포커스는 호출자가 다시 소유한다.
    NSWindow *window = view.window;
    NSResponder *first = window.firstResponder;
    BOOL targetOwnsResponder = first == view ||
        ([first isKindOfClass:NSView.class] && [(NSView *)first isDescendantOf:view]);
    if (window && !targetOwnsResponder) [window makeFirstResponder:view];
    // 시간 초과나 등록 해제가 drain 전에 대기를 끝냈으면 이미 완료를 보고했으므로 보내지 않는다.
    void (^sendAfterDrain)(void) = ^{
        if (![handler.waits containsObject:wait]) return;
        BOOL sent = send();
        if (!sent && [handler.waits containsObject:wait]) {
            [[wait retain] autorelease];
            [handler.waits removeObject:wait];
            wait.done(NO);
        }
    };
    [view _doAfterProcessingAllPendingMouseEvents:sendAfterDrain];
}

static NSEvent *routePointer(NSEvent *event) {
    NSWindow *window = event.window;
    if (!window) return event;
    NSView *content = window.contentView;
    NSPoint point = [content.superview convertPoint:event.locationInWindow fromView:nil];
    NSView *hit = [content hitTest:point];
    // 등록한 웹뷰 안에 다른 등록한 웹뷰(문서 영역)가 있으면 가장 안쪽의 웹뷰만 이동을 받는다.
    NSView *target = hit;
    while (target && ![inputViews containsObject:target]) target = target.superview;
    WKWebView *previous = [lastPointerTargets objectForKey:window];
    for (WKWebView *view in inputViews) {
        if (view.window == window) [view _setIgnoresMouseMoveEvents:view != target];
    }
    if (NSEvent.pressedMouseButtons != 0) {
        [lastPointerTargets removeObjectForKey:window];
    } else if (target != previous) {
        if (target) [lastPointerTargets setObject:(WKWebView *)target forKey:window];
        else [lastPointerTargets removeObjectForKey:window];
        if (target) refreshPointerCursor((WKWebView *)target, event);
    }
    return event;
}

BOOL webviewInputRegister(WKWebView *view) {
    NSCAssert(NSThread.isMainThread, @"Webview input registration requires the main thread");
    if (![view respondsToSelector:@selector(_setIgnoresMouseMoveEvents:)]) return NO;
    if (!hasPendingMouseDrain(view)) return NO;
    if (!inputViews) {
        inputViews = [[NSHashTable weakObjectsHashTable] retain];
        lastPointerTargets = [[NSMapTable weakToWeakObjectsMapTable] retain];
        [NSNotificationCenter.defaultCenter addObserverForName:NSApplicationDidBecomeActiveNotification object:NSApp queue:nil
            usingBlock:^(NSNotification *note) { [lastPointerTargets removeAllObjects]; }];
        // 마우스 이탈 이벤트에서는 추적 대상을 변경하지 않는다. 휠 이벤트는 표면 좌표계의 단위로 바꾼다.
        [NSEvent addLocalMonitorForEventsMatchingMask:NSEventMaskMouseMoved | NSEventMaskMouseEntered | NSEventMaskScrollWheel
            handler:^NSEvent *(NSEvent *event) {
                if (event.type != NSEventTypeScrollWheel) return routePointer(event);
                NSView *content = event.window.contentView;
                if (!content) return event;
                NSView *hit = [content hitTest:[content.superview convertPoint:event.locationInWindow fromView:nil]];
                return webviewScrollInViewUnits(event, hit);
            }];
    }
    [inputViews addObject:view];
    installReceipts(view);
    return YES;
}

void webviewInputUnregister(WKWebView *view) {
    NSCAssert(NSThread.isMainThread, @"Webview input removal requires the main thread");
    [view _setIgnoresMouseMoveEvents:NO];
    [inputViews removeObject:view];
    SPInputRegistration *registration = objc_getAssociatedObject(view, &registrationKey);
    [registration end];
    objc_setAssociatedObject(view, &registrationKey, nil, OBJC_ASSOCIATION_RETAIN_NONATOMIC);
}

BOOL webviewIgnorePageFocus(WKWebView *view) {
    NSCAssert(NSThread.isMainThread, @"webview focus belongs to the main thread");
    // 페이지가 요소에 focus 를 주면 WebKit 은 first responder 를 web view 로 옮긴다
    // (PageClientImpl::makeFirstResponder). 로드를 마친 표면이 열린 메뉴나 입력 중인
    // 페이지에서 키 입력을 가져가게 된다.
    if (![view respondsToSelector:@selector(_setShouldSuppressFirstResponderChanges:)]) return NO;
    [view _setShouldSuppressFirstResponderChanges:YES];
    return YES;
}
