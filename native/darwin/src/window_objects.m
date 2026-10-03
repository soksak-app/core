#import <Cocoa/Cocoa.h>
#import <stdatomic.h>
#import "window_objects.h"

// 객체는 보통 메인 스레드에서 해제되지만 마지막 참조를 놓는 스레드를 라이브러리가 정하지 않으므로 원자 연산으로 센다.
static atomic_long counts[3];

void sp_window_object_change(sp_window_object_kind kind, long delta) {
    atomic_fetch_add(&counts[kind], delta);
}

sp_window_objects sp_window_objects_count(void) {
    return (sp_window_objects){
        .windowCompositions = atomic_load(&counts[SP_WINDOW_OBJECT_COMPOSITION]),
        .surfaceHosts = atomic_load(&counts[SP_WINDOW_OBJECT_SURFACE_HOST]),
        .inputRegistrations = atomic_load(&counts[SP_WINDOW_OBJECT_INPUT_REGISTRATION]),
    };
}

// 이 라이브러리가 넣는 애플리케이션 정의 이벤트의 subtype. 프레임워크가 실행 반복을 깨우려고 넣는 이벤트는
// subtype 0 이다. data1 은 요청마다 다른 번호다.
static const short kAfterEventSubtype = 0x5350;

void sp_window_objects_after_event(sp_window_objects_done done, void *context) {
    NSCAssert(NSThread.isMainThread, @"sp_window_objects_after_event requires the main thread");
    static NSInteger sequence;
    NSInteger token = ++sequence;
    __block id monitor = nil;
    // 지역 모니터는 -[NSApplication sendEvent:] 가 이벤트를 분배할 때 불린다. 그 반복의 자동 해제 풀은 sendEvent:
    // 가 돌아온 뒤 비워지므로, 수는 다음 메인 큐 차례에 센다.
    monitor = [NSEvent addLocalMonitorForEventsMatchingMask:NSEventMaskApplicationDefined handler:^NSEvent *(NSEvent *event) {
        if (event.subtype != kAfterEventSubtype || event.data1 != token) return event;
        // 처리기 안에서 모니터를 제거하면 실행 중인 이 블록이 해제될 수 있으므로 다음 차례에 제거한다.
        id installed = monitor;
        dispatch_async(dispatch_get_main_queue(), ^{
            [NSEvent removeMonitor:installed];
            sp_window_objects current = sp_window_objects_count();
            done(context, &current);
        });
        return nil;
    }];
    NSEvent *event = [NSEvent otherEventWithType:NSEventTypeApplicationDefined location:NSZeroPoint modifierFlags:0
        timestamp:0 windowNumber:0 context:nil subtype:kAfterEventSubtype data1:token data2:0];
    [NSApp postEvent:event atStart:NO];
}
