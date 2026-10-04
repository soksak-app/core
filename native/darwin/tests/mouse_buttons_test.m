// 마우스 버튼 감시가 설치한 차례와 애플리케이션에 전달된 마우스 버튼의 누름과 뗌마다 AppKit 이 보고하는 mask 를
// 알리는지 검사한다. 애플리케이션을 활성화하지 않는다.
//
// 다른 애플리케이션에 전달되는 누름과 뗌(global event monitor)은 사람의 버튼이나 창 서버에 게시한 실제 입력으로만
// 생기므로 이 검사는 다루지 않는다. 그 경로는 창 검사가 host.buttons 로 관측한다.
#import <Cocoa/Cocoa.h>
#import "mouse_buttons.h"

static int failures = 0;

static void check(BOOL condition, NSString *message) {
    fprintf(condition ? stdout : stderr, "%s: %s\n", condition ? "PASS" : "FAIL", message.UTF8String);
    if (!condition) failures++;
}

// 알림마다 mask 와 그 차례에 AppKit 이 보고한 mask 를 기록한다.
static NSMutableArray<NSArray<NSNumber *> *> *reports;

static void changed(void *context, unsigned long long mask) {
    [reports addObject:@[@(mask), @(NSEvent.pressedMouseButtons), @(NSThread.isMainThread), @((uintptr_t)context)]];
}

static NSEvent *mouse(NSEventType type) {
    return [NSEvent mouseEventWithType:type location:NSZeroPoint modifierFlags:0
        timestamp:NSProcessInfo.processInfo.systemUptime windowNumber:0 context:nil eventNumber:0
        clickCount:type == NSEventTypeMouseMoved ? 0 : 1 pressure:0];
}

// 이벤트 대기열의 이벤트를 꺼내 애플리케이션에 전달한다. 로컬 이벤트 감시는 이 전달에서 이벤트를 받는다.
static void pump(NSString *what, BOOL (^done)(void)) {
    NSDate *deadline = [NSDate dateWithTimeIntervalSinceNow:10];
    while (!done() && deadline.timeIntervalSinceNow > 0) {
        NSEvent *event = [NSApp nextEventMatchingMask:NSEventMaskAny
            untilDate:[NSDate dateWithTimeIntervalSinceNow:0.01] inMode:NSDefaultRunLoopMode dequeue:YES];
        if (event) [NSApp sendEvent:event];
    }
    if (!done()) { fprintf(stderr, "FAIL: %s within 10 seconds (%lu reports)\n", what.UTF8String, (unsigned long)reports.count); exit(1); }
}

int main(void) { @autoreleasepool {
    [NSApplication sharedApplication];
    [NSApp setActivationPolicy:NSApplicationActivationPolicyAccessory];
    reports = [NSMutableArray array];

    // dispatch_sync 는 블록을 호출한 스레드에서 실행할 수 있으므로 다른 스레드에서 실행하고 끝나기를 기다린다.
    __block bool background = true;
    dispatch_semaphore_t finished = dispatch_semaphore_create(0);
    [NSThread detachNewThreadWithBlock:^{
        background = sp_mouse_buttons_watch(changed, (void *)7);
        dispatch_semaphore_signal(finished);
    }];
    dispatch_semaphore_wait(finished, DISPATCH_TIME_FOREVER);
    dispatch_release(finished);
    check(!background && reports.count == 0, @"a watch outside the main thread is refused and reports nothing");

    check(sp_mouse_buttons_watch(changed, (void *)7), @"the watch is installed on the main thread");
    check(reports.count == 1 && [reports[0][0] isEqual:reports[0][1]] && [reports[0][2] boolValue] && [reports[0][3] unsignedLongValue] == 7,
        [NSString stringWithFormat:@"the watch reports the current mask once on the main thread when it is installed: %@", reports]);
    check(!sp_mouse_buttons_watch(changed, (void *)8) && reports.count == 1, @"a second watch is refused");

    // 버튼 없는 이동은 알리지 않는다. 대기열은 차례대로 꺼내므로 마지막 뗌을 알린 뒤에는 이동도 전달되었다.
    NSEventType types[] = {
        NSEventTypeMouseMoved,
        NSEventTypeLeftMouseDown, NSEventTypeLeftMouseUp,
        NSEventTypeRightMouseDown, NSEventTypeRightMouseUp,
        NSEventTypeOtherMouseDown, NSEventTypeOtherMouseUp,
        NSEventTypeMouseMoved,
    };
    for (size_t i = 0; i < sizeof types / sizeof types[0]; i++) [NSApp postEvent:mouse(types[i]) atStart:NO];
    // 마지막 이동 뒤에 표지를 넣어 대기열의 모든 이벤트가 전달된 차례를 안다.
    __block BOOL drained = NO;
    NSEvent *marker = [NSEvent otherEventWithType:NSEventTypeApplicationDefined location:NSZeroPoint modifierFlags:0
        timestamp:0 windowNumber:0 context:nil subtype:0x4654 data1:0 data2:0];
    id markerMonitor = [NSEvent addLocalMonitorForEventsMatchingMask:NSEventMaskApplicationDefined handler:^NSEvent *(NSEvent *event) {
        if (event.subtype == 0x4654) drained = YES;
        return event;
    }];
    [NSApp postEvent:marker atStart:NO];
    pump(@"the posted events were not delivered", ^BOOL { return drained; });
    [NSEvent removeMonitor:markerMonitor];
    BOOL matching = reports.count == 7;
    for (NSArray<NSNumber *> *report in reports) {
        matching = matching && [report[0] isEqual:report[1]] && [report[2] boolValue] && [report[3] unsignedLongValue] == 7;
    }
    check(matching, [NSString stringWithFormat:
        @"each left, right, and other button press and release delivered to the application reports the AppKit mask, and a move reports nothing: %@",
        reports]);

    return failures ? 1 : 0;
}}
