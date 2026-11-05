#import <Foundation/Foundation.h>
#include <limits.h>
#include <stdatomic.h>
#include "event_ring.h"
#include "observe.h"
#include "stall_watch.h"

// The time of the last answer on the clock of sp_mono_ns, or of the first heartbeat while none exists.
static _Atomic uint64_t lastAnswer;
// True from the start of a wait of the main run loop until it wakes.
static atomic_bool runLoopWaits;
// The threads that wait for a wake of the run loop. Each one is signaled once.
static _Atomic uint32_t blockedThreads;
static dispatch_semaphore_t runLoopWoke;

static void wakeBlockedThreads(void) {
    for (uint32_t count = atomic_exchange(&blockedThreads, 0); count > 0; count--) dispatch_semaphore_signal(runLoopWoke);
}

static void observeRunLoop(void) {
    static dispatch_once_t once;
    dispatch_once(&once, ^{
        runLoopWoke = dispatch_semaphore_create(0);
        // The orders put the wait between every other observer of the turn, because a commit of Core Animation runs before the wait
        // and a blocked commit is a stall, and so is whatever runs right after a wake. A turn takes one of each, so the deliveries
        // are counted.
        sp_observe_run_loop("stall_watch.waits", SP_OBSERVE_COUNT, CFRunLoopGetMain(), kCFRunLoopBeforeWaiting, true, LONG_MAX, ^{
            atomic_store(&lastAnswer, sp_mono_ns());
            atomic_store(&runLoopWaits, true);
        });
        sp_observe_run_loop("stall_watch.wakes", SP_OBSERVE_COUNT, CFRunLoopGetMain(), kCFRunLoopAfterWaiting, true, LONG_MIN, ^{
            atomic_store(&lastAnswer, sp_mono_ns());
            atomic_store(&runLoopWaits, false);
            wakeBlockedThreads();
        });
    });
}

void sp_stall_heartbeat(uint64_t *now, uint64_t *answered) {
    observeRunLoop();
    uint64_t sent = sp_mono_ns();
    uint64_t none = 0;
    atomic_compare_exchange_strong(&lastAnswer, &none, sent);
    if (atomic_load(&runLoopWaits)) {
        uint64_t waitStarted = atomic_load(&lastAnswer);
        *now = waitStarted;
        *answered = waitStarted;
        return;
    }
    CFRunLoopRef loop = CFRunLoopGetMain();
    CFRunLoopPerformBlock(loop, kCFRunLoopCommonModes, ^{ atomic_store(&lastAnswer, sp_mono_ns()); });
    CFRunLoopWakeUp(loop);
    *now = sent;
    *answered = atomic_load(&lastAnswer);
}

void sp_stall_await_awake(void) {
    observeRunLoop();
    while (atomic_load(&runLoopWaits)) {
        atomic_fetch_add(&blockedThreads, 1);
        // A wake between the check above and the addition did not count this thread, so it signals for itself.
        if (!atomic_load(&runLoopWaits)) wakeBlockedThreads();
        dispatch_semaphore_wait(runLoopWoke, DISPATCH_TIME_FOREVER);
    }
}
