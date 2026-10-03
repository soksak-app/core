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

static BOOL same(sp_window_objects left, sp_window_objects right) {
    return left.windowCompositions == right.windowCompositions && left.surfaceHosts == right.surfaceHosts &&
        left.inputRegistrations == right.inputRegistrations;
}

// 수를 기다리는 요청. 메인 스레드에서만 다룬다.
@interface SPObjectsWaiter : NSObject {
@public
    BOOL hasExpected;
    sp_window_objects expected;
    sp_window_objects_done done;
    void *context;
}
@end

@implementation SPObjectsWaiter
@end

// 이 라이브러리가 넣는 애플리케이션 정의 이벤트의 subtype. 프레임워크가 실행 반복을 깨우려고 넣는 이벤트는
// subtype 0 이다.
static const short kDrainSubtype = 0x5350;

static NSMutableArray<SPObjectsWaiter *> *waiters;
static id drainMonitor;
static CFRunLoopObserverRef idleObserver;
// 넣은 이벤트가 아직 처리되지 않았는지. 처리되지 않은 이벤트는 하나만 둔다.
static BOOL drainPending;

static void postDrain(void) {
    if (drainPending) return;
    drainPending = YES;
    NSEvent *event = [NSEvent otherEventWithType:NSEventTypeApplicationDefined location:NSZeroPoint modifierFlags:0
        timestamp:0 windowNumber:0 context:nil subtype:kDrainSubtype data1:0 data2:0];
    [NSApp postEvent:event atStart:NO];
}

static void settle(SPObjectsWaiter *waiter, bool reached) {
    [[waiter retain] autorelease];
    [waiters removeObjectIdenticalTo:waiter];
    if (waiters.count == 0) {
        [NSEvent removeMonitor:drainMonitor];
        drainMonitor = nil;
        // 아직 처리되지 않은 이벤트는 모니터 없이 분배되므로 다음 요청은 새 이벤트를 넣는다.
        drainPending = NO;
        CFRunLoopObserverInvalidate(idleObserver);
        CFRelease(idleObserver);
        idleObserver = NULL;
    }
    sp_window_objects current = sp_window_objects_count();
    waiter->done(waiter->context, &current, reached);
}

// 넣은 이벤트를 처리한 반복의 자동 해제 풀이 비워진 뒤에 부른다.
static void compareWaiters(void) {
    sp_window_objects current = sp_window_objects_count();
    for (SPObjectsWaiter *waiter in [[waiters copy] autorelease]) {
        if (!waiter->hasExpected || same(current, waiter->expected)) settle(waiter, true);
    }
}

// AppKit 은 이벤트 반복의 자동 해제 풀을 비우는 동안 해제된 객체가 자동 해제한 객체를 다음 반복의 풀이 비워질 때
// 해제한다. 화면에 있던 창은 닫기 애니메이션이 끝날 때 해제되고, 그 창의 콘텐츠 뷰가 이렇게 자동 해제되면 그 안의
// 객체는 이벤트 두 번 뒤에 해제된다. 풀에 남은 객체를 알리는 사건은 없으므로, 요청이 기다리는 동안 메인 실행
// 반복이 잠들기 전마다 이벤트 하나를 넣어 풀을 비우고 수를 비교한다.
static void installDrain(void) {
    if (!waiters) waiters = [[NSMutableArray alloc] init];
    if (drainMonitor) return;
    // 지역 모니터는 -[NSApplication sendEvent:] 가 이벤트를 분배할 때 불린다. 그 반복의 자동 해제 풀은 sendEvent:
    // 가 돌아온 뒤 비워지므로, 수는 다음 메인 큐 차례에 비교한다.
    drainMonitor = [NSEvent addLocalMonitorForEventsMatchingMask:NSEventMaskApplicationDefined handler:^NSEvent *(NSEvent *event) {
        if (event.subtype != kDrainSubtype) return event;
        drainPending = NO;
        dispatch_async(dispatch_get_main_queue(), ^{ compareWaiters(); });
        return nil;
    }];
    idleObserver = CFRunLoopObserverCreateWithHandler(NULL, kCFRunLoopBeforeWaiting, true, INT_MAX,
        ^(CFRunLoopObserverRef observer, CFRunLoopActivity activity) { postDrain(); });
    CFRunLoopAddObserver(CFRunLoopGetMain(), idleObserver, kCFRunLoopCommonModes);
}

void sp_window_objects_when(const sp_window_objects *expected, double seconds, sp_window_objects_done done,
    void *context) {
    NSCAssert(NSThread.isMainThread, @"sp_window_objects_when requires the main thread");
    SPObjectsWaiter *waiter = [[[SPObjectsWaiter alloc] init] autorelease];
    waiter->hasExpected = expected != NULL;
    if (expected) waiter->expected = *expected;
    waiter->done = done;
    waiter->context = context;
    installDrain();
    [waiters addObject:waiter];
    postDrain();
    // 기대값에 이르지 않는 수에는 알릴 사건이 없다. 기한은 그 실패를 알리는 데만 쓴다.
    dispatch_after(dispatch_time(DISPATCH_TIME_NOW, (int64_t)(seconds * NSEC_PER_SEC)), dispatch_get_main_queue(), ^{
        if ([waiters indexOfObjectIdenticalTo:waiter] != NSNotFound) settle(waiter, false);
    });
}
