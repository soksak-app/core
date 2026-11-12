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
// The counts of sp_stall_counts: the heartbeats that sent their block to the main thread, the sends whose wake reached a run loop
// that waited, and the blocks of heartbeats that ran.
static _Atomic uint64_t heartbeatsSent;
static _Atomic uint64_t heartbeatsSentInWait;
static _Atomic uint64_t heartbeatsAnswered;
// Set by sp_stall_set_send_in_next_wait_for_test until a send of sp_stall_await_awake reaches a wait of the run loop. Each call of
// the setter takes the next generation, so an injected send that missed its wait sets the injection again only for its own setting.
static atomic_bool sendInNextWait;
static _Atomic uint64_t sendInNextWaitSetting;
typedef void (*blocked_hook)(void);
// The hook of sp_stall_set_blocked_hook_for_test, or none.
static _Atomic(blocked_hook) blockedHook;

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

// Sends the block of a heartbeat to the main run loop and wakes it. The state of the run loop is read again right before the wake,
// so a wake that reaches a wait is counted, and the send returns whether it reached one.
static bool sendHeartbeat(void) {
    CFRunLoopRef loop = CFRunLoopGetMain();
    CFRunLoopPerformBlock(loop, kCFRunLoopCommonModes, ^{
        atomic_store(&lastAnswer, sp_mono_ns());
        atomic_fetch_add(&heartbeatsAnswered, 1);
    });
    atomic_fetch_add(&heartbeatsSent, 1);
    bool inWait = atomic_load(&runLoopWaits);
    if (inWait) atomic_fetch_add(&heartbeatsSentInWait, 1);
    CFRunLoopWakeUp(loop);
    return inWait;
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
    sendHeartbeat();
    *now = sent;
    *answered = atomic_load(&lastAnswer);
}

void sp_stall_await_awake(void) {
    observeRunLoop();
    uint64_t setting = atomic_load(&sendInNextWaitSetting);
    if (atomic_load(&runLoopWaits) && atomic_exchange(&sendInNextWait, false)) {
        // Another source can wake the run loop between the state read above and the send, and the send then reaches no wait: the
        // fault was not made, so the injection stays set for the next wait unless the checks changed it meanwhile.
        if (!sendHeartbeat()) {
            bool cleared = false;
            if (atomic_load(&sendInNextWaitSetting) == setting) atomic_compare_exchange_strong(&sendInNextWait, &cleared, true);
        }
        return;
    }
    while (atomic_load(&runLoopWaits)) {
        atomic_fetch_add(&blockedThreads, 1);
        blocked_hook hook = atomic_load_explicit(&blockedHook, memory_order_acquire);
        if (hook) hook();
        // A wake between the check above and the addition did not count this thread, so it signals for itself.
        if (!atomic_load(&runLoopWaits)) wakeBlockedThreads();
        dispatch_semaphore_wait(runLoopWoke, DISPATCH_TIME_FOREVER);
    }
}

void sp_stall_set_blocked_hook_for_test(void (*blocked)(void)) {
    atomic_store_explicit(&blockedHook, blocked, memory_order_release);
}

void sp_stall_counts(uint64_t *sent, uint64_t *sent_in_wait, uint64_t *answered) {
    *sent = atomic_load(&heartbeatsSent);
    *sent_in_wait = atomic_load(&heartbeatsSentInWait);
    *answered = atomic_load(&heartbeatsAnswered);
}

void sp_stall_set_send_in_next_wait_for_test(bool send) {
    atomic_fetch_add(&sendInNextWaitSetting, 1);
    atomic_store(&sendInNextWait, send);
}
