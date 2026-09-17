// 네이티브 입력 이벤트를 만들어 창의 뷰에 전달한다.
//
// 키 이벤트는 -[NSWindow sendEvent:] 로 창의 응답자에게 전달한다. 포인터 이벤트는 창이
// 활성 상태가 아니면 AppKit 이 첫 클릭으로 처리해 뷰에 전달하지 않으므로, 좌표의 뷰를
// 히트 테스트해 그 뷰의 이벤트 메서드로 전달한다. 이동은 좌표를 포함하는 추적 영역의
// 소유자에게 전달한다. 어느 경우든 웹뷰는 네이티브 이벤트를 받아 페이지에 신뢰 이벤트를
// 전달한다. 스크롤은 창 정보를 가진 이벤트로 만들어 -[NSWindow sendEvent:] 로 전달한다.
// 시스템 커서를 움직이지 않고 애플리케이션을 활성화하지 않는다.
#import <Cocoa/Cocoa.h>
#import "input_inject.h"

// CoreGraphics 의 공개되지 않은 이벤트 필드와 함수다. docs/operations/private-native-apis.md 참고.
static const CGEventField kCGEventWindowNumberField = (CGEventField)51;
extern void CGEventSetWindowLocation(CGEventRef event, CGPoint location);

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

bool sp_input_pointer(void *handle, double x, double y, int phase, int button, double deltaX, double deltaY) {
    NSWindow *window = (__bridge NSWindow *)handle;
    if (!window || !NSThread.isMainThread) return false;
    NSPoint point = windowPoint(window, x, y);
    if (phase == 0) return moveTo(window, point);
    if (phase == 4) {
        // 공개 API 에는 창 정보를 가진 스크롤 이벤트를 만드는 방법이 없다. CGEvent 에 창 번호
        // (필드 51)와 창 좌표(CGEventSetWindowLocation)를 넣으면 창과 locationInWindow 를
        // 가진 NSEvent 가 되고, -[NSWindow sendEvent:] 가 좌표의 뷰에 전달한다. 둘 다 공개되지
        // 않은 CoreGraphics 기능이므로 docs/operations/private-native-apis.md 에 기록하고
        // tests/input_inject_test.m 이 실제 스크롤 여부를 검사한다.
        CGEventRef scroll = CGEventCreateScrollWheelEvent2(NULL, kCGScrollEventUnitPixel, 2,
            (int32_t)-deltaY, (int32_t)-deltaX, 0);
        if (!scroll) return false;
        NSPoint screen = [window convertPointToScreen:point];
        CGFloat top = NSMaxY(NSScreen.screens.firstObject.frame);
        CGEventSetLocation(scroll, CGPointMake(screen.x, top - screen.y));
        CGEventSetIntegerValueField(scroll, kCGEventWindowNumberField, window.windowNumber);
        CGEventSetWindowLocation(scroll, CGPointMake(point.x, NSHeight(window.frame) - point.y));
        NSEvent *event = [NSEvent eventWithCGEvent:scroll];
        CFRelease(scroll);
        if (event.window != window) return false;
        [window sendEvent:event];
        return true;
    }
    NSView *hit = hitView(window, point);
    if (!hit) return false;
    BOOL right = button == 1;
    switch (phase) {
        case 1:
            if (right) [hit rightMouseDown:mouseEvent(window, NSEventTypeRightMouseDown, point, 1, 1)];
            else [hit mouseDown:mouseEvent(window, NSEventTypeLeftMouseDown, point, 1, 1)];
            return true;
        case 2:
            if (right) [hit rightMouseDragged:mouseEvent(window, NSEventTypeRightMouseDragged, point, 0, 1)];
            else [hit mouseDragged:mouseEvent(window, NSEventTypeLeftMouseDragged, point, 0, 1)];
            return true;
        case 3:
            if (right) [hit rightMouseUp:mouseEvent(window, NSEventTypeRightMouseUp, point, 1, 0)];
            else [hit mouseUp:mouseEvent(window, NSEventTypeLeftMouseUp, point, 1, 0)];
            return true;
        default:
            return false;
    }
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
