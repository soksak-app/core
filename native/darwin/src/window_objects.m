#import <Cocoa/Cocoa.h>
#import <stdatomic.h>
#import "window_objects.h"
#import "observe.h"

// An object is usually released on the main thread, but the library does not decide which thread drops
// the last reference, so the count uses atomic operations.
static atomic_long counts[3];
// Whether a request waits for a count, read by sp_window_object_change on any thread.
static atomic_bool waiting;

static void postDrain(void);

void sp_window_object_change(sp_window_object_kind kind, long delta) {
    atomic_fetch_add(&counts[kind], delta);
    // A change while a request waits drains the next autorelease pool, which may hold what this release autoreleased.
    if (atomic_load(&waiting)) dispatch_async(dispatch_get_main_queue(), ^{ if (atomic_load(&waiting)) postDrain(); });
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
        atomic_store(&waiting, false);
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
// inside it are released after two events. Each release changes the count, and each change while a request
// waits queues one event that empties the next pool, so the drains follow the releases and stop when nothing
// changes.
static void installDrain(void) {
    if (!waiters) waiters = [[NSMutableArray alloc] init];
    if (drainMonitor) return;
    // A local monitor is called when -[NSApplication sendEvent:] dispatches the event. The autorelease pool of
    // that iteration is emptied after sendEvent: returns, so the count is compared in the next main queue turn.
    drainMonitor = sp_observe_local_monitor("window_objects.drain", SP_OBSERVE_COUNT, NSEventMaskApplicationDefined, ^NSEvent *(NSEvent *event) {
        if (event.subtype != kDrainSubtype) return event;
        drainPending = NO;
        dispatch_async(dispatch_get_main_queue(), ^{ compareWaiters(); });
        return nil;
    });
}

void sp_window_objects_when(const sp_window_objects *expected, sp_window_objects_done done, void *context) {
    NSCAssert(NSThread.isMainThread, @"sp_window_objects_when requires the main thread");
    SPObjectsWaiter *waiter = [[[SPObjectsWaiter alloc] init] autorelease];
    waiter->hasExpected = expected != NULL;
    if (expected) waiter->expected = *expected;
    waiter->done = done;
    waiter->context = context;
    installDrain();
    [waiters addObject:waiter];
    atomic_store(&waiting, true);
    postDrain();
}

void sp_window_objects_end(void *context) {
    NSCAssert(NSThread.isMainThread, @"sp_window_objects_end requires the main thread");
    for (SPObjectsWaiter *waiter in [[waiters copy] autorelease]) {
        if (waiter->context == context) settle(waiter, false);
    }
}
