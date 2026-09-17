// 네이티브 입력 이벤트를 만들어 창의 뷰에 전달한다.
//
// 키 이벤트는 -[NSWindow sendEvent:] 로 창의 응답자에게 전달한다. 포인터 이벤트는 창이
// 활성 상태가 아니면 AppKit 이 첫 클릭으로 처리해 뷰에 전달하지 않으므로, 좌표의 뷰를
// 히트 테스트해 그 뷰의 이벤트 메서드로 전달한다. 이동은 좌표를 포함하는 추적 영역의
// 소유자에게 전달한다. 어느 경우든 웹뷰는 네이티브 이벤트를 받아 페이지에 신뢰 이벤트를
// 전달한다. 스크롤은 창 정보를 가진 이벤트로 만들어 -[NSWindow sendEvent:] 로 전달한다.
// 시스템 커서를 움직이지 않고, sp_input_activate 외에는 애플리케이션을 활성화하지 않는다.
//
// WebKit 은 페이지가 활성(창이 키 창)일 때만 버튼 없는 이동으로 호버를 갱신한다
// (WebFrame::handleMouseEvent). 그래서 키 창이 아닌 창의 이동은 SP_INPUT_INACTIVE 로 거부하고,
// 호버가 필요한 호출자는 sp_input_activate 로 창을 실제로 활성화한 뒤 이동을 보낸다.
#import <Cocoa/Cocoa.h>
#import "input_inject.h"
#import "private/coregraphics.h"
#import "private/webkit.h"

// 콘텐츠 영역 왼쪽 위 기준 좌표를 창 좌표로 바꾼다. 콘텐츠 뷰의 좌표계 방향을 따른다.
static NSPoint windowPoint(NSWindow *window, double x, double y) {
    NSView *content = window.contentView;
    NSPoint local = NSMakePoint(x, content.isFlipped ? y : content.bounds.size.height - y);
    return [content convertPoint:local toView:nil];
}

static NSEventModifierFlags flags(unsigned modifiers) {
    NSEventModifierFlags result = 0;
    if (modifiers & 1) result |= NSEventModifierFlagShift;
    if (modifiers & 2) result |= NSEventModifierFlagControl;
    if (modifiers & 4) result |= NSEventModifierFlagOption;
    if (modifiers & 8) result |= NSEventModifierFlagCommand;
    return result;
}

static NSView *hitView(NSWindow *window, NSPoint point) {
    NSView *content = window.contentView;
    return [content hitTest:[content.superview convertPoint:point fromView:nil]];
}

static NSEvent *mouseEvent(NSWindow *window, NSEventType type, NSPoint point, NSInteger clicks, float pressure) {
    return [NSEvent mouseEventWithType:type location:point modifierFlags:0
        timestamp:NSProcessInfo.processInfo.systemUptime windowNumber:window.windowNumber
        context:nil eventNumber:0 clickCount:clicks pressure:pressure];
}

// 좌표를 포함하는 추적 영역의 소유자에게 이동을 전달한다. 겹친 뷰에서는 가장 위의 뷰만 받는다.
static bool moveTo(NSWindow *window, NSPoint point) {
    NSView *hit = hitView(window, point);
    if (!hit) return false;
    NSEvent *event = mouseEvent(window, NSEventTypeMouseMoved, point, 0, 0);
    for (NSView *view = hit; view; view = view.superview) {
        [view updateTrackingAreas];
        for (NSTrackingArea *area in view.trackingAreas) {
            if (!(area.options & NSTrackingMouseMoved)) continue;
            if (!NSPointInRect([view convertPoint:point fromView:nil], area.rect) && !(area.options & NSTrackingInVisibleRect)) continue;
            [area.owner mouseMoved:event];
            return true;
        }
    }
    return false;
}

sp_input_result sp_input_pointer(void *handle, double x, double y, int phase, int button, double deltaX, double deltaY) {
    NSWindow *window = (__bridge NSWindow *)handle;
    if (!window || !NSThread.isMainThread) return SP_INPUT_REJECTED;
    NSPoint point = windowPoint(window, x, y);
    if (phase == 0) {
        if (!window.isKeyWindow) return SP_INPUT_INACTIVE;
        return moveTo(window, point) ? SP_INPUT_DELIVERED : SP_INPUT_REJECTED;
    }
    if (phase == 4) {
        // 공개 API 에는 창 정보를 가진 스크롤 이벤트를 만드는 방법이 없다. CGEvent 에 창 번호
        // (필드 51)와 창 좌표(CGEventSetWindowLocation)를 넣으면 창과 locationInWindow 를
        // 가진 NSEvent 가 되고, -[NSWindow sendEvent:] 가 좌표의 뷰에 전달한다. 둘 다 공개되지
        // 않은 CoreGraphics 기능이므로 docs/operations/private-native-apis.md 에 기록하고
        // tests/input_inject_test.m 이 실제 스크롤 여부를 검사한다.
        CGEventRef scroll = CGEventCreateScrollWheelEvent2(NULL, kCGScrollEventUnitPixel, 2,
            (int32_t)-deltaY, (int32_t)-deltaX, 0);
        if (!scroll) return SP_INPUT_REJECTED;
        NSPoint screen = [window convertPointToScreen:point];
        CGFloat top = NSMaxY(NSScreen.screens.firstObject.frame);
        CGEventSetLocation(scroll, CGPointMake(screen.x, top - screen.y));
        CGEventSetIntegerValueField(scroll, kSPEventWindowNumberField, window.windowNumber);
        CGEventSetWindowLocation(scroll, CGPointMake(point.x, NSHeight(window.frame) - point.y));
        NSEvent *event = [NSEvent eventWithCGEvent:scroll];
        CFRelease(scroll);
        if (event.window != window) return SP_INPUT_REJECTED;
        [window sendEvent:event];
        return SP_INPUT_DELIVERED;
    }
    NSView *hit = hitView(window, point);
    if (!hit) return SP_INPUT_REJECTED;
    BOOL right = button == 1;
    switch (phase) {
        case 1:
            if (right) [hit rightMouseDown:mouseEvent(window, NSEventTypeRightMouseDown, point, 1, 1)];
            else [hit mouseDown:mouseEvent(window, NSEventTypeLeftMouseDown, point, 1, 1)];
            return SP_INPUT_DELIVERED;
        case 2:
            if (right) [hit rightMouseDragged:mouseEvent(window, NSEventTypeRightMouseDragged, point, 0, 1)];
            else [hit mouseDragged:mouseEvent(window, NSEventTypeLeftMouseDragged, point, 0, 1)];
            return SP_INPUT_DELIVERED;
        case 3:
            if (right) [hit rightMouseUp:mouseEvent(window, NSEventTypeRightMouseUp, point, 1, 0)];
            else [hit mouseUp:mouseEvent(window, NSEventTypeLeftMouseUp, point, 1, 0)];
            return SP_INPUT_DELIVERED;
        default:
            return SP_INPUT_REJECTED;
    }
}

static void collectWebViews(NSView *view, NSMutableArray<WKWebView *> *found) {
    if ([view isKindOfClass:WKWebView.class]) [found addObject:(WKWebView *)view];
    for (NSView *child in view.subviews) collectWebViews(child, found);
}

// 창 안의 모든 웹뷰가 활성 상태를 웹 프로세스에 보낸 뒤 done 을 호출한다. WebKit 은 키 창 알림을
// 받으면 활성 상태 전송을 예약하고, _doAfterActivityStateUpdate: 는 예약된 전송이 끝난 뒤(예약이
// 없으면 즉시) 호출된다. 알림의 다른 관찰자가 모두 실행된 뒤 등록하도록 다음 메인 큐 차례에서 등록한다.
static void afterWebViewsActive(NSWindow *window, void (^done)(void)) {
    dispatch_async(dispatch_get_main_queue(), ^{
        NSMutableArray<WKWebView *> *views = [NSMutableArray array];
        collectWebViews(window.contentView.superview ?: window.contentView, views);
        __block NSUInteger pending = views.count;
        if (pending == 0) { done(); return; }
        for (WKWebView *view in views) {
            [view _doAfterActivityStateUpdate:^{
                if (--pending == 0) done();
            }];
        }
    });
}

void sp_input_activate(void *handle, double timeoutSeconds, void (*done)(void *context, bool ok), void *context) {
    NSWindow *window = (__bridge NSWindow *)handle;
    if (!window || !NSThread.isMainThread) { done(context, false); return; }
    NSNotificationCenter *center = NSNotificationCenter.defaultCenter;
    __block bool finished = false;
    __block bool waiting = true;
    __block id keyObserver = nil;
    __block id appObserver = nil;
    void (^stopWaiting)(void) = ^{
        if (!waiting) return;
        waiting = false;
        [center removeObserver:keyObserver];
        [center removeObserver:appObserver];
    };
    void (^finish)(bool) = ^(bool ok) {
        if (finished) return;
        finished = true;
        stopWaiting();
        done(context, ok);
    };
    // 키 창 알림과 앱 활성 알림의 순서는 정해져 있지 않으므로 두 알림에서 모두 확인한다.
    void (^check)(void) = ^{
        if (!waiting || !NSApp.isActive || !window.isKeyWindow) return;
        stopWaiting();
        afterWebViewsActive(window, ^{ finish(true); });
    };
    if (NSApp.isActive && window.isKeyWindow) {
        waiting = false;
        afterWebViewsActive(window, ^{ finish(true); });
        return;
    }
    keyObserver = [center addObserverForName:NSWindowDidBecomeKeyNotification object:window queue:nil
        usingBlock:^(NSNotification *note) { check(); }];
    appObserver = [center addObserverForName:NSApplicationDidBecomeActiveNotification object:NSApp queue:nil
        usingBlock:^(NSNotification *note) { check(); }];
    // 시스템은 활성화 요청을 거절할 수 있고(macOS 14 협조적 활성화), 활성화 직후 사용자가 다른 앱으로
    // 포커스를 옮길 수도 있다. 제한 시간은 활성화와 웹뷰 상태 전송 전체에 적용해 결과를 반드시 보고한다.
    dispatch_after(dispatch_time(DISPATCH_TIME_NOW, (int64_t)(timeoutSeconds * NSEC_PER_SEC)),
        dispatch_get_main_queue(), ^{ finish(false); });
    [window makeKeyAndOrderFront:nil];
    [NSApp activate];
}

typedef struct { const char *name; unsigned short code; unichar character; } SPKey;

static const SPKey keys[] = {
    {"Enter", 36, '\r'}, {"Tab", 48, '\t'}, {"Escape", 53, 27}, {"Backspace", 51, 127},
    {"Delete", 117, NSDeleteFunctionKey}, {"Space", 49, ' '},
    {"ArrowLeft", 123, NSLeftArrowFunctionKey}, {"ArrowRight", 124, NSRightArrowFunctionKey},
    {"ArrowDown", 125, NSDownArrowFunctionKey}, {"ArrowUp", 126, NSUpArrowFunctionKey},
    {"Home", 115, NSHomeFunctionKey}, {"End", 119, NSEndFunctionKey},
    {"PageUp", 116, NSPageUpFunctionKey}, {"PageDown", 121, NSPageDownFunctionKey},
};

bool sp_input_key(void *handle, const char *key, const char *text, unsigned modifiers, bool down) {
    NSWindow *window = (__bridge NSWindow *)handle;
    if (!window || !key || !NSThread.isMainThread) return false;
    NSString *name = [NSString stringWithUTF8String:key];
    NSString *characters = nil;
    unsigned short code = 0;
    for (size_t i = 0; i < sizeof(keys) / sizeof(keys[0]); i++) {
        if (strcmp(keys[i].name, key) == 0) {
            code = keys[i].code;
            characters = [NSString stringWithCharacters:&keys[i].character length:1];
            break;
        }
    }
    if (!characters) {
        if (name.length != 1) return false;
        characters = name;
    }
    if (text) characters = [NSString stringWithUTF8String:text];
    NSEvent *event = [NSEvent keyEventWithType:down ? NSEventTypeKeyDown : NSEventTypeKeyUp
        location:NSZeroPoint modifierFlags:flags(modifiers)
        timestamp:NSProcessInfo.processInfo.systemUptime windowNumber:window.windowNumber
        context:nil characters:characters charactersIgnoringModifiers:characters
        isARepeat:NO keyCode:code];
    if (!event) return false;
    [window sendEvent:event];
    return true;
}
