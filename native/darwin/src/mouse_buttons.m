// AppKit 이 보고하는 눌린 마우스 버튼 mask 를 알린다.
//
// 사람의 버튼은 이 애플리케이션이 비활성이고 다른 애플리케이션이 최전면인 동안에도 NSEvent.pressedMouseButtons 를
// 바꾸고, input_inject.m 은 그 mask 가 0 이 아니면 합성 누름과 뗌을 거부한다. 다른 애플리케이션에 전달되는 버튼
// 이벤트는 전역 이벤트 감시가 받고, 이 애플리케이션에 전달되는 버튼 이벤트는 로컬 이벤트 감시가 받는다. 두 감시
// 모두 공개 AppKit API 이고, 마우스 이벤트의 전역 감시는 손쉬운 사용 권한을 요구하지 않는다.
#import <Cocoa/Cocoa.h>
#import "mouse_buttons.h"

static const NSEventMask buttonEvents = NSEventMaskLeftMouseDown | NSEventMaskLeftMouseUp
    | NSEventMaskRightMouseDown | NSEventMaskRightMouseUp | NSEventMaskOtherMouseDown | NSEventMaskOtherMouseUp;

static id localMonitor, globalMonitor;

bool sp_mouse_buttons_watch(sp_mouse_buttons_changed changed, void *context) {
    if (!changed || !NSThread.isMainThread || localMonitor || globalMonitor) return false;
    // 감시의 처리기는 메인 스레드에서 실행된다. mask 는 이벤트가 아니라 처리하는 차례의 AppKit 상태에서 읽는다.
    void (^report)(void) = ^{ changed(context, NSEvent.pressedMouseButtons); };
    id local = [NSEvent addLocalMonitorForEventsMatchingMask:buttonEvents handler:^NSEvent *(NSEvent *event) {
        report();
        return event;
    }];
    id global = [NSEvent addGlobalMonitorForEventsMatchingMask:buttonEvents handler:^(NSEvent *event) {
        report();
    }];
    if (!local || !global) {
        if (local) [NSEvent removeMonitor:local];
        if (global) [NSEvent removeMonitor:global];
        return false;
    }
    localMonitor = [local retain];
    globalMonitor = [global retain];
    report();
    return true;
}
