#import <Cocoa/Cocoa.h>
#import <stdatomic.h>
#import "window_objects.h"

// An object is usually released on the main thread, but the library does not decide which thread drops
// the last reference, so the count uses atomic operations.
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

// A request that waits for a count. Handled only on the main thread.
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

// Subtype of the application-defined events that this library queues. Events that the framework queues to
// wake the run loop have subtype 0.
static const short kDrainSubtype = 0x5350;

static NSMutableArray<SPObjectsWaiter *> *waiters;
static id drainMonitor;
static CFRunLoopObserverRef idleObserver;
// Whether a queued event has not been handled yet. At most one unhandled event is kept.
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
        // An unhandled event is dispatched without a monitor, so the next request queues a new event.
        drainPending = NO;
        CFRunLoopObserverInvalidate(idleObserver);
        CFRelease(idleObserver);
        idleObserver = NULL;
    }
    sp_window_objects current = sp_window_objects_count();
    waiter->done(waiter->context, &current, reached);
}

// Called after the autorelease pool of the iteration that handled the queued event was emptied.
static void compareWaiters(void) {
    sp_window_objects current = sp_window_objects_count();
    for (SPObjectsWaiter *waiter in [[waiters copy] autorelease]) {
        if (!waiter->hasExpected || same(current, waiter->expected)) settle(waiter, true);
    }
}

// AppKit releases an object that was autoreleased by an object released while the autorelease pool of an
// event iteration is emptied when the pool of the next iteration is emptied. A window that was on screen is
// released when its close animation ends, and when its content view is autoreleased this way, the objects
// inside it are released after two events. No event reports an object left in the pool, so while a request
// waits, one event is queued before the main run loop sleeps each time to empty the pool, and the count
// is compared.
static void installDrain(void) {
    if (!waiters) waiters = [[NSMutableArray alloc] init];
    if (drainMonitor) return;
    // A local monitor is called when -[NSApplication sendEvent:] dispatches the event. The autorelease pool of
    // that iteration is emptied after sendEvent: returns, so the count is compared in the next main queue turn.
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
    // No event reports a count that does not reach the expected value. The deadline only reports that failure.
    dispatch_after(dispatch_time(DISPATCH_TIME_NOW, (int64_t)(seconds * NSEC_PER_SEC)), dispatch_get_main_queue(), ^{
        if ([waiters indexOfObjectIdenticalTo:waiter] != NSNotFound) settle(waiter, false);
    });
}
