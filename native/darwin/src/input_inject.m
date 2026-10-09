// 네이티브 입력 이벤트를 만들어 창의 뷰에 전달한다.
//
// 키 이벤트는 -[NSWindow sendEvent:] 로 창의 응답자에게 전달한다. 포인터 이벤트는 창이
// 활성 상태가 아니면 AppKit 이 첫 클릭으로 처리해 뷰에 전달하지 않으므로, 좌표의 뷰를
// 히트 테스트해 누름을 전달하고 끌기와 뗌은 누름 대상에 전달한다. 이동은 좌표를 포함하는 추적 영역의
// 소유자에게 전달한다. 어느 경우든 웹뷰는 네이티브 이벤트를 받아 페이지에 신뢰 이벤트를
// 전달한다. 스크롤은 창 정보를 가진 이벤트로 만들어 -[NSWindow sendEvent:] 로 전달한다.
// 시스템 커서를 움직이지 않고, sp_input_activate 외에는 애플리케이션을 활성화하지 않는다.
//
// WebKit 은 페이지가 활성(창이 키 창)일 때만 버튼 없는 이동으로 호버를 갱신한다
// (WebFrame::handleMouseEvent). 그래서 키 창이 아닌 창의 이동은 SP_INPUT_INACTIVE 로 거부하고,
// 호버가 필요한 호출자는 sp_input_activate 로 창을 실제로 활성화한 뒤 이동을 보낸다.
#import <Cocoa/Cocoa.h>
#import <objc/runtime.h>
#import "input_inject.h"
#import "application_log.h"
#import "webview_input.h"
#import "webview_geometry.h"
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

// 창과 버튼마다 누름을 받은 뷰가 뗌까지 같은 제스처를 받는다.
static char leftPressedViewKey, rightPressedViewKey;
static const void *pressedViewKey(int button) {
    return button == 1 ? &rightPressedViewKey : &leftPressedViewKey;
}
static NSView *pointerTarget(NSWindow *window, NSPoint point, int phase, int button) {
    return phase == 2 || phase == 3 ? objc_getAssociatedObject(window, pressedViewKey(button)) : hitView(window, point);
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

// SP_INPUT_BUTTON_HELD 로 거부한 차례의 측정값. front 는 보유한 참조이며 heldDone 이 놓는다.
typedef struct {
    NSUInteger buttons;
    NSRunningApplication *front;
    // 거부한 이유. 전달했으면 빈 문자열이다.
    const char *why;
} SPHeld;

// held 는 결과가 SP_INPUT_BUTTON_HELD 일 때 거부한 차례의 mask 와 최전면 애플리케이션을 받는다.
static sp_input_result pointerInput(void *handle, double x, double y, int phase, int button, double deltaX, double deltaY,
    SPHeld *held) {
    NSWindow *window = (__bridge NSWindow *)handle;
    held->why = "";
    if (!window || !NSThread.isMainThread) { held->why = "no window or not the main thread"; return SP_INPUT_REJECTED; }
    NSPoint point = windowPoint(window, x, y);
    if (phase == 0) {
        if (!window.isKeyWindow) { held->why = "the window is not the key window"; return SP_INPUT_INACTIVE; }
        if (!moveTo(window, point)) { held->why = "no tracking area at the point"; return SP_INPUT_REJECTED; }
        return SP_INPUT_DELIVERED;
    }
    if (phase == 4) {
        // 공개 API 에는 창 정보를 가진 스크롤 이벤트를 만드는 방법이 없다. CGEvent 에 창 번호
        // (필드 51)와 창 좌표(CGEventSetWindowLocation)를 넣으면 창과 locationInWindow 를
        // 가진 NSEvent 가 되고, -[NSWindow sendEvent:] 가 좌표의 뷰에 전달한다. 둘 다 공개되지
        // 않은 CoreGraphics 기능이므로 docs/operations/private-native-apis.md 에 기록하고
        // tests/input_inject_test.m 이 실제 스크롤 여부를 검사한다.
        CGEventRef scroll = CGEventCreateScrollWheelEvent2(NULL, kCGScrollEventUnitPixel, 2,
            (int32_t)-deltaY, (int32_t)-deltaX, 0);
        if (!scroll) { held->why = "the scroll event cannot be created"; return SP_INPUT_REJECTED; }
        // 원본 없는 이벤트는 실제 수정 키 상태를 물려받는다. 포인터 입력은 수정 키를 받지 않으므로 비운다.
        CGEventSetFlags(scroll, 0);
        NSPoint screen = [window convertPointToScreen:point];
        CGFloat top = NSMaxY(NSScreen.screens.firstObject.frame);
        CGEventSetLocation(scroll, CGPointMake(screen.x, top - screen.y));
        CGEventSetIntegerValueField(scroll, kSPEventWindowNumberField, window.windowNumber);
        CGEventSetWindowLocation(scroll, CGPointMake(point.x, NSHeight(window.frame) - point.y));
        NSEvent *event = [NSEvent eventWithCGEvent:scroll];
        CFRelease(scroll);
        if (event.window != window) { held->why = "the scroll event has another window"; return SP_INPUT_REJECTED; }
        // 실제 휠 이벤트는 앱의 이벤트 모니터가 표면 좌표계 단위로 바꾼다. sendEvent 는 모니터를 거치지 않는다.
        [window sendEvent:webviewScrollInViewUnits(event, hitView(window, point))];
        return SP_INPUT_DELIVERED;
    }
    NSView *hit = pointerTarget(window, point, phase, button);
    if (!hit) { held->why = phase == 2 || phase == 3 ? "no open press for the drag or release" : "no view at the point"; return SP_INPUT_REJECTED; }
    if (hit.window != window) {
        objc_setAssociatedObject(window, pressedViewKey(button), nil, OBJC_ASSOCIATION_RETAIN_NONATOMIC);
        held->why = "the target view left the window";
        return SP_INPUT_REJECTED;
    }
    // WebKit 은 마우스 이벤트의 눌린 버튼을 이벤트가 아니라 +[NSEvent pressedMouseButtons] 로 읽는다.
    // AppKit 이 눌린 버튼을 보고하는 동안의 누름과 뗌은 WebKit 에서 pointerdown 이나 pointerup 대신
    // pointermove 로 처리될 수 있으므로 전달하지 않고 알린다. 이 상태만으로 버튼 상태의 원인은 알 수 없으므로
    // 거부한 같은 차례에 mask 와 최전면 애플리케이션을 측정해 함께 알린다.
    NSUInteger buttons = NSEvent.pressedMouseButtons;
    if ((phase == 1 || phase == 3) && buttons != 0) {
        held->buttons = buttons;
        held->front = [NSWorkspace.sharedWorkspace.frontmostApplication retain];
        held->why = "AppKit reports a pressed mouse button";
        return SP_INPUT_BUTTON_HELD;
    }
    BOOL right = button == 1;
    switch (phase) {
        case 1:
            // 열린 누름은 전달된 뗌이 끝낸다. 거부된 뗌은 누름을 열어 두므로 다음 누름은 그 사실을 알린다.
            if (objc_getAssociatedObject(window, pressedViewKey(button))) { held->why = "a press of this button is still open"; return SP_INPUT_PRESS_OPEN; }
            objc_setAssociatedObject(window, pressedViewKey(button), hit, OBJC_ASSOCIATION_RETAIN_NONATOMIC);
            // -[NSWindow sendEvent:] 는 누른 뷰가 받을 수 있으면 첫 응답자로 만든 뒤 누름을 전달한다.
            // 이 경로는 뷰에 직접 전달하므로 같은 순서를 따른다. 호스트의 표면 웹뷰는 누름만으로
            // 첫 응답자가 되지 않는다(e2e/shell.test.mjs). 창이나 앱을 활성화하지 않는다.
            if (hit != window.firstResponder && hit.acceptsFirstResponder) [window makeFirstResponder:hit];
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
            objc_setAssociatedObject(window, pressedViewKey(button), nil, OBJC_ASSOCIATION_RETAIN_NONATOMIC);
            return SP_INPUT_DELIVERED;
        default:
            held->why = "unknown phase";
            return SP_INPUT_REJECTED;
    }
}

// 주입한 입력의 결과 이름.
static const char *resultName(sp_input_result result) {
    switch (result) {
        case SP_INPUT_DELIVERED: return "delivered";
        case SP_INPUT_REJECTED: return "rejected";
        case SP_INPUT_INACTIVE: return "inactive";
        case SP_INPUT_UNRECEIVED: return "unreceived";
        case SP_INPUT_BUTTON_HELD: return "button held";
        case SP_INPUT_PRESS_OPEN: return "press open";
    }
    return "unknown";
}

// 주입한 포인터 입력 하나를 인자, 결과, 거부 이유와 함께 기록한다. 호출자가 결과를 받는 모든 경로가 쓴다.
static void logPointer(double x, double y, int phase, int button, double deltaX, double deltaY,
    sp_input_result result, const char *why) {
    NSString *text = [NSString stringWithFormat:
        @"{\"kind\":\"pointer\",\"x\":%g,\"y\":%g,\"phase\":%d,\"button\":%d,\"deltaX\":%g,\"deltaY\":%g,\"result\":\"%s\",\"reason\":\"%s\"}",
        x, y, phase, button, deltaX, deltaY, resultName(result), why ?: ""];
    sp_log_info("input inject", text.UTF8String);
}

sp_input_result sp_input_pointer(void *handle, double x, double y, int phase, int button, double deltaX, double deltaY) {
    SPHeld held = {0, nil, ""};
    sp_input_result result = pointerInput(handle, x, y, phase, button, deltaX, deltaY, &held);
    logPointer(x, y, phase, button, deltaX, deltaY, result, held.why);
    [held.front release];
    return result;
}

// done 을 호출하고 held 의 참조를 놓는다. held 는 result 가 SP_INPUT_BUTTON_HELD 일 때만 보고한다.
static void heldDone(sp_input_done done, void *context, sp_input_result result, SPHeld held) {
    if (result != SP_INPUT_BUTTON_HELD) {
        [held.front release];
        done(context, result, NULL);
        return;
    }
    sp_input_held report = {
        .mask = held.buttons,
        .pid = held.front ? held.front.processIdentifier : -1,
        .bundleIdentifier = held.front.bundleIdentifier.UTF8String,
    };
    done(context, result, &report);
    [held.front release];
}

// 입력을 전달하고 결과를 곧바로 done 으로 알린다.
static void pointerNow(void *handle, double x, double y, int phase, int button, double deltaX, double deltaY,
    sp_input_done done, void *context) {
    SPHeld held = {0, nil, ""};
    sp_input_result result = pointerInput(handle, x, y, phase, button, deltaX, deltaY, &held);
    logPointer(x, y, phase, button, deltaX, deltaY, result, held.why);
    heldDone(done, context, result, held);
}

// 좌표에서 이벤트를 받는 가장 안쪽 웹뷰.
static WKWebView *webViewAt(NSWindow *window, double x, double y) {
    NSView *view = hitView(window, windowPoint(window, x, y));
    while (view && ![view isKindOfClass:WKWebView.class]) view = view.superview;
    return (WKWebView *)view;
}

void sp_input_pointer_then(void *handle, double x, double y, int phase, int button, double deltaX, double deltaY,
    double timeoutSeconds, sp_input_done done, void *context) {
    NSWindow *window = (__bridge NSWindow *)handle;
    NSView *pressed = window && NSThread.isMainThread ? pointerTarget(window, windowPoint(window, x, y), phase, button) : nil;
    while (pressed && ![pressed isKindOfClass:WKWebView.class]) pressed = pressed.superview;
    WKWebView *target = (WKWebView *)pressed;
    if (phase == 4 && target) {
        // 새 문서의 스크롤 트리가 표시되기 전에 받은 휠 이벤트는 문서를 움직이지 않는다. 대상 웹뷰가 현재
        // 상태를 표시한 뒤 전달한다. 제한 시간 안에 표시하지 않으면 전달하지 않고 알린다.
        __block BOOL finished = NO;
        [target _doAfterNextPresentationUpdate:^{
            if (finished) return;
            finished = YES;
            pointerNow(handle, x, y, phase, button, deltaX, deltaY, done, context);
        }];
        dispatch_after(dispatch_time(DISPATCH_TIME_NOW, (int64_t)(timeoutSeconds * NSEC_PER_SEC)), dispatch_get_main_queue(), ^{
            if (finished) return;
            finished = YES;
            logPointer(x, y, phase, button, deltaX, deltaY, SP_INPUT_UNRECEIVED, "the scroll target did not present within the limit");
            done(context, SP_INPUT_UNRECEIVED, NULL);
        });
        return;
    }
    if (phase != 1 && phase != 3) {
        pointerNow(handle, x, y, phase, button, deltaX, deltaY, done, context);
        return;
    }
    if (!target) {
        pointerNow(handle, x, y, phase, button, deltaX, deltaY, done, context);
        return;
    }
    // 문서가 pointerdown 이나 pointerup 을 받은 뒤 완료한다. 받은 뒤 WebKit 의 대기 중인 마우스 처리를
    // 기다리므로, 뗌이 만드는 click 도 다음 요청보다 먼저 처리된다.
    __block sp_input_result result = SP_INPUT_REJECTED;
    __block SPHeld held = {0, nil, "the press or release was not sent"};
    webviewInputSendThen(target, phase == 3 ? @"pointerup" : @"pointerdown", timeoutSeconds, ^BOOL {
        result = pointerInput(handle, x, y, phase, button, deltaX, deltaY, &held);
        return result == SP_INPUT_DELIVERED;
    }, ^(BOOL received) {
        sp_input_result final = result == SP_INPUT_DELIVERED && received ? SP_INPUT_DELIVERED :
            result == SP_INPUT_DELIVERED ? SP_INPUT_UNRECEIVED : result;
        logPointer(x, y, phase, button, deltaX, deltaY, final,
            final == SP_INPUT_UNRECEIVED ? "the document did not receive the press or release within the limit" : held.why);
        heldDone(done, context, final, held);
    });
}

static void collectVisibleWebViews(NSView *view, NSMutableArray<WKWebView *> *found, BOOL ancestorVisible) {
    BOOL visible = ancestorVisible && !view.hidden && view.alphaValue > 0 && view.window != nil;
    if (visible && [view isKindOfClass:WKWebView.class]) [found addObject:(WKWebView *)view];
    for (NSView *child in view.subviews) collectVisibleWebViews(child, found, visible);
}

// 창 안의 모든 웹뷰가 활성 상태를 웹 프로세스에 보낸 뒤 done 을 호출한다. WebKit 은 키 창 알림을
// 받으면 활성 상태 전송을 예약하고, _doAfterActivityStateUpdate: 는 예약된 전송이 끝난 뒤(예약이
// 없으면 즉시) 호출된다. 알림의 다른 관찰자가 모두 실행된 뒤 등록하도록 다음 메인 큐 차례에서 등록한다.
static void afterWebViewsActive(NSWindow *window, WKWebView *target, BOOL waitForAll, void (^done)(void)) {
    dispatch_async(dispatch_get_main_queue(), ^{
        if (target) {
            [target _doAfterActivityStateUpdate:done];
            return;
        }
        if (!waitForAll) { done(); return; }
        NSMutableArray<WKWebView *> *views = [NSMutableArray array];
        collectVisibleWebViews(window.contentView.superview ?: window.contentView, views, YES);
        __block NSUInteger pending = views.count;
        if (pending == 0) { done(); return; }
        for (WKWebView *view in views) {
            [view _doAfterActivityStateUpdate:^{
                if (--pending == 0) done();
            }];
        }
    });
}

static void report(sp_activate_done done, void *context, sp_activate_result result) {
    if (result == SP_ACTIVATE_DONE) { done(context, result, NULL); return; }
    NSRunningApplication *front = NSWorkspace.sharedWorkspace.frontmostApplication;
    NSString *name = front.bundleIdentifier ?: front.localizedName;
    done(context, result, name.UTF8String);
}

static void activateWindow(NSWindow *window, WKWebView *target, BOOL waitForAll, double timeoutSeconds, sp_activate_done done, void *context) {
    if (!window || !NSThread.isMainThread) { report(done, context, SP_ACTIVATE_REJECTED); return; }
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
    void (^finish)(sp_activate_result) = ^(sp_activate_result result) {
        if (finished) return;
        finished = true;
        stopWaiting();
        report(done, context, result);
    };
    // 웹뷰가 활성 상태를 보낸 뒤에도 활성 상태인지 확인한다. 그 사이 다른 앱이나 창이 초점을 가져갈 수 있다.
    void (^applied)(void) = ^{
        finish(NSApp.isActive && window.isKeyWindow ? SP_ACTIVATE_DONE : SP_ACTIVATE_LOST);
    };
    // 키 창 알림과 앱 활성 알림의 순서는 정해져 있지 않으므로 두 알림에서 모두 확인한다.
    void (^check)(void) = ^{
        if (!waiting || !NSApp.isActive || !window.isKeyWindow) return;
        stopWaiting();
        afterWebViewsActive(window, target, waitForAll, applied);
    };
    // 시스템은 활성화 요청을 거절할 수 있고(macOS 14 협조적 활성화), 활성화 직후 사용자가 다른 앱으로
    // 포커스를 옮길 수도 있다. 제한 시간은 활성화와 웹뷰 상태 전송 전체에 적용해 멈춘 단계를 반드시 보고한다.
    dispatch_after(dispatch_time(DISPATCH_TIME_NOW, (int64_t)(timeoutSeconds * NSEC_PER_SEC)),
        dispatch_get_main_queue(), ^{
            if (!waiting) finish(SP_ACTIVATE_PENDING);
            else finish(NSApp.isActive ? SP_ACTIVATE_NOT_KEY : SP_ACTIVATE_REFUSED);
        });
    if (NSApp.isActive && window.isKeyWindow) {
        waiting = false;
        afterWebViewsActive(window, target, waitForAll, applied);
        return;
    }
    keyObserver = [center addObserverForName:NSWindowDidBecomeKeyNotification object:window queue:nil
        usingBlock:^(NSNotification *note) { check(); }];
    appObserver = [center addObserverForName:NSApplicationDidBecomeActiveNotification object:NSApp queue:nil
        usingBlock:^(NSNotification *note) { check(); }];
    [window makeKeyAndOrderFront:nil];
    [NSApp activateIgnoringOtherApps:YES];
}

void sp_input_activate(void *handle, double timeoutSeconds, sp_activate_done done, void *context) {
    activateWindow((__bridge NSWindow *)handle, nil, YES, timeoutSeconds, done, context);
}

void sp_input_activate_at(void *handle, double x, double y, double timeoutSeconds, sp_activate_done done, void *context) {
    NSWindow *window = (__bridge NSWindow *)handle;
    WKWebView *target = window && NSThread.isMainThread ? webViewAt(window, x, y) : nil;
    activateWindow(window, target, NO, timeoutSeconds, done, context);
}

typedef struct { const char *name; unsigned short code; } SPKey;

// 이름 있는 키의 macOS 키 코드. 문자는 AppKit 이 키 코드와 현재 입력 소스로 계산한다.
static const SPKey keys[] = {
    {"Enter", 36}, {"Tab", 48}, {"Escape", 53}, {"Backspace", 51},
    {"Delete", 117}, {"Space", 49},
    {"ArrowLeft", 123}, {"ArrowRight", 124},
    {"ArrowDown", 125}, {"ArrowUp", 126},
    {"Home", 115}, {"End", 119},
    {"PageUp", 116}, {"PageDown", 121},
};

// 문자만 담은 NSEvent에는 물리 키 정체성이 없다. NSTextInputContext가 현재
// 키보드 입력 소스를 적용하려면 키 코드가 필요하며, 한글 조합도 여기에
// 포함된다. 아래 코드는 endpoint가 지정한 문자를 macOS ANSI 키보드 위치로
// 변환하며, 알 수 없는 문자는 추측한 코드로 바꾸지 않고 거부한다.
static unsigned short characterKeyCode(unichar character) {
    static const char *letters = "abcdefghijklmnopqrstuvwxyz";
    static const unsigned short letterCodes[] = {0, 11, 8, 2, 14, 3, 5, 4, 34, 38, 40, 37, 46, 45, 31, 35, 12, 15, 1, 17, 32, 9, 13, 7, 16, 6};
    for (NSUInteger i = 0; i < 26; i++) if (character == letters[i]) return letterCodes[i];
    static const char digits[] = "1234567890";
    static const unsigned short digitCodes[] = {18, 19, 20, 21, 23, 22, 26, 28, 25, 29};
    for (NSUInteger i = 0; i < 10; i++) if (character == digits[i]) return digitCodes[i];
    return USHRT_MAX;
}

static CGEventFlags cgFlags(unsigned modifiers) {
    CGEventFlags result = 0;
    if (modifiers & 1) result |= kCGEventFlagMaskShift;
    if (modifiers & 2) result |= kCGEventFlagMaskControl;
    if (modifiers & 4) result |= kCGEventFlagMaskAlternate;
    if (modifiers & 8) result |= kCGEventFlagMaskCommand;
    return result;
}

static sp_input_result keyInput(void *handle, const char *key, const char *text, unsigned modifiers, bool down,
    const char **why) {
    NSWindow *window = (__bridge NSWindow *)handle;
    *why = "";
    if (!window || !key || !NSThread.isMainThread) { *why = "no window, no key or not the main thread"; return SP_INPUT_REJECTED; }
    NSString *name = [NSString stringWithUTF8String:key];
    unsigned short code = USHRT_MAX;
    for (size_t i = 0; i < sizeof(keys) / sizeof(keys[0]); i++) {
        if (strcmp(keys[i].name, key) == 0) {
            code = keys[i].code;
            break;
        }
    }
    if (code == USHRT_MAX) {
        if (name.length != 1) { *why = "unknown key name"; return SP_INPUT_REJECTED; }
        code = characterKeyCode([name characterAtIndex:0]);
        if (code == USHRT_MAX) { *why = "unknown key name"; return SP_INPUT_REJECTED; }
    }
    NSString *characters = text ? [NSString stringWithUTF8String:text] : nil;
    NSEvent *event = nil;
    if (!text) {
        // AppKit이 물리 키와 현재 입력 소스로부터 문자를 계산하게 한다. 이름 있는 키도 같다.
        // 호출자의 문자를 직접 넣은 이벤트는 입력기를 거치지 않는다(조합 중 Backspace 등).
        CGEventRef raw = CGEventCreateKeyboardEvent(NULL, code, down);
        if (raw) {
            CGEventSetFlags(raw, cgFlags(modifiers));
            CGEventSetIntegerValueField(raw, kSPEventWindowNumberField, window.windowNumber);
            event = [NSEvent eventWithCGEvent:raw];
            CFRelease(raw);
        }
    } else {
        event = [NSEvent keyEventWithType:down ? NSEventTypeKeyDown : NSEventTypeKeyUp
            location:NSZeroPoint modifierFlags:flags(modifiers)
            timestamp:NSProcessInfo.processInfo.systemUptime windowNumber:window.windowNumber
            context:nil characters:characters charactersIgnoringModifiers:characters
            isARepeat:NO keyCode:code];
    }
    if (!event) { *why = "the key event cannot be created"; return SP_INPUT_REJECTED; }
    // 사람의 키는 키 창에만 간다. 다른 창이 키 창이면 대상 창에 전달하지 않고 알린다.
    NSWindow *keyWindow = NSApp.keyWindow;
    if (keyWindow && keyWindow != window) { *why = "another window is the key window"; return SP_INPUT_INACTIVE; }
    // 대상 창이 키 창이면 사람의 키와 같이 -[NSApplication sendEvent:] 로 분배한다. 메뉴의 키 대응(Command+C,
    // Command+V)도 AppKit 이 판단한다. 키 창이 없는 비활성 애플리케이션에는 사람의 키가 오지 않으므로, 창을
    // 활성화하지 않는 검사를 위해 대상 창에 보낸다.
    if (keyWindow == window) [NSApp sendEvent:event];
    else [window sendEvent:event];
    return SP_INPUT_DELIVERED;
}

// text 의 JSON 문자열. text 가 NULL 이면 null 이다.
static NSString *jsonText(const char *text) {
    if (!text) return @"null";
    NSData *data = [NSJSONSerialization dataWithJSONObject:[NSString stringWithUTF8String:text]
        options:NSJSONWritingFragmentsAllowed error:NULL];
    return data ? [[[NSString alloc] initWithData:data encoding:NSUTF8StringEncoding] autorelease] : @"null";
}

sp_input_result sp_input_key(void *handle, const char *key, const char *text, unsigned modifiers, bool down) {
    const char *why = "";
    sp_input_result result = keyInput(handle, key, text, modifiers, down, &why);
    NSString *record = [NSString stringWithFormat:
        @"{\"kind\":\"key\",\"key\":%@,\"text\":%@,\"modifiers\":%u,\"down\":%s,\"result\":\"%s\",\"reason\":\"%s\"}",
        jsonText(key), jsonText(text), modifiers, down ? "true" : "false", resultName(result), why];
    sp_log_info("input inject", record.UTF8String);
    return result;
}
