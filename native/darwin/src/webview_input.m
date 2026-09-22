#import <Cocoa/Cocoa.h>
#import "webview_input.h"
// _setIgnoresMouseMoveEvents: gates pointer tracking without disabling keyboard,
// clicks or drags. AppKit's hit test selects the webview that receives it.
#import "private/webkit.h"
#import "webview_geometry.h"

static NSHashTable *inputViews;

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

static NSMapTable<WKWebView *, SPInputReceipts *> *receipts;

static void installReceipts(WKWebView *view) {
    if (!receipts) receipts = [[NSMapTable weakToStrongObjectsMapTable] retain];
    if ([receipts objectForKey:view]) return;
    SPInputReceipts *handler = [[SPInputReceipts new] autorelease];
    handler.waits = [NSMutableArray array];
    WKContentWorld *world = [WKContentWorld worldWithName:kReceiptWorld];
    WKUserContentController *controller = view.configuration.userContentController;
    [controller addScriptMessageHandler:handler contentWorld:world name:kReceiptMessage];
    [controller addUserScript:[[[WKUserScript alloc] initWithSource:kReceiptScript
        injectionTime:WKUserScriptInjectionTimeAtDocumentStart forMainFrameOnly:YES inContentWorld:world] autorelease]];
    // 이미 읽은 문서에는 사용자 스크립트가 적용되지 않으므로 같은 world 에서 한 번 실행한다.
    if (view.URL) [view evaluateJavaScript:kReceiptScript inFrame:nil inContentWorld:world completionHandler:nil];
    [receipts setObject:handler forKey:view];
}

void webviewInputReceive(WKWebView *view, NSString *type, NSTimeInterval timeout, void (^done)(BOOL received)) {
    NSCAssert(NSThread.isMainThread, @"Webview input receipts require the main thread");
    SPInputReceipts *handler = [receipts objectForKey:view];
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
    SPInputReceipts *handler = [receipts objectForKey:view];
    if (!handler) {
        done(send());
        return;
    }
    SPInputWait *wait = [[SPInputWait new] autorelease];
    wait.type = type;
    wait.done = ^(BOOL received) {
        if (!received || ![view respondsToSelector:@selector(_doAfterProcessingAllPendingMouseEvents:)]) {
            done(received);
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
    void (^sendAfterDrain)(void) = ^{
        BOOL sent = send();
        if (!sent) {
            [handler.waits removeObject:wait];
            wait.done(NO);
        }
    };
    if ([view respondsToSelector:@selector(_doAfterProcessingAllPendingMouseEvents:)]) {
        [view _doAfterProcessingAllPendingMouseEvents:sendAfterDrain];
    } else {
        sendAfterDrain();
    }
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
    for (WKWebView *view in inputViews) {
        if (view.window == window) [view _setIgnoresMouseMoveEvents:view != target];
    }
    return event;
}

BOOL webviewInputRegister(WKWebView *view) {
    NSCAssert(NSThread.isMainThread, @"Webview input registration requires the main thread");
    if (![view respondsToSelector:@selector(_setIgnoresMouseMoveEvents:)]) return NO;
    if (!inputViews) {
        inputViews = [[NSHashTable weakObjectsHashTable] retain];
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
    SPInputReceipts *handler = [receipts objectForKey:view];
    if (handler) {
        [view.configuration.userContentController removeScriptMessageHandlerForName:kReceiptMessage
            contentWorld:[WKContentWorld worldWithName:kReceiptWorld]];
        NSArray *waits = [[handler.waits copy] autorelease];
        [handler.waits removeAllObjects];
        for (SPInputWait *wait in waits) wait.done(NO);
        [receipts removeObjectForKey:view];
    }
}

BOOL webviewIgnorePageFocus(WKWebView *view) {
    NSCAssert(NSThread.isMainThread, @"webview focus belongs to the main thread");
    // WebKit moves the first responder to the web view when its page focuses an
    // element (PageClientImpl::makeFirstResponder). A surface that finishes
    // loading would take the keys from an open menu or the page being typed in.
    if (![view respondsToSelector:@selector(_setShouldSuppressFirstResponderChanges:)]) return NO;
    [view _setShouldSuppressFirstResponderChanges:YES];
    return YES;
}
